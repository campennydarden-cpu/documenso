import type { Recipient } from '@prisma/client';
import { SigningStatus } from '@prisma/client';

import { isCcRecipient } from './recipients';

/**
 * A recipient "step" is the set of non-CC recipients sharing a signing order.
 * A step with 2 or more members is a "signing group": members may act in any
 * order among themselves, and the next step only unlocks once every member of
 * the group has completed their action.
 */

type GroupableRecipient = Pick<Recipient, 'role'> & {
  signingOrder?: number | null;
};

export type RecipientStep<T> = {
  /**
   * The signing order shared by all members of the step.
   */
  order: number;
  members: T[];
};

const UNORDERED = Number.MAX_SAFE_INTEGER;

/**
 * The signing order to sort and group by, treating "no order" as last.
 *
 * Exported so callers outside this module share one definition of the
 * null-as-last convention rather than restating it.
 */
export const effectiveOrder = (recipient: { signingOrder?: number | null }) => recipient.signingOrder ?? UNORDERED;

/**
 * Derives the ordered list of steps from a list of recipients.
 *
 * - Non-CC recipients sharing a signing order form one step.
 * - Recipients without a signing order share a single tail step.
 * - CC recipients are returned separately and never belong to a step.
 */
export const groupRecipientsBySigningOrder = <T extends GroupableRecipient>(recipients: T[]) => {
  const ccRecipients = recipients.filter((recipient) => isCcRecipient(recipient));
  const nonCcRecipients = recipients.filter((recipient) => !isCcRecipient(recipient));

  const membersByOrder = new Map<number, T[]>();

  for (const recipient of nonCcRecipients) {
    const order = effectiveOrder(recipient);
    const members = membersByOrder.get(order) ?? [];

    members.push(recipient);
    membersByOrder.set(order, members);
  }

  const steps: RecipientStep<T>[] = [...membersByOrder.entries()]
    .sort(([orderA], [orderB]) => orderA - orderB)
    .map(([order, members]) => ({ order, members }));

  return { steps, ccRecipients };
};

/**
 * Index of the last step containing a recipient that can no longer be modified,
 * or -1 when there is none.
 *
 * Signing is sequential, so anyone who has already acted sits at or before the
 * current step. Everything up to and including that step is therefore treated
 * as locked: those signing orders are persisted values the server will not let
 * us rewrite. Steps after it can only hold recipients who have not acted, so
 * they can be renumbered and reordered freely — no anchoring required.
 *
 * Stated as "up to and including the last locked step" rather than "the locked
 * prefix" deliberately: a locked recipient can appear out of sequence (direct
 * templates sign at their template order, field insertion has no turn check,
 * and a document can be switched from parallel to sequential mid-flight). This
 * form stays correct in those cases, just more conservative.
 */
export const getLastLockedStepIndex = <T extends GroupableRecipient>(
  steps: RecipientStep<T>[],
  canUpdateRecipient: (recipient: T) => boolean = () => true,
): number =>
  steps.reduce(
    (lastIndex, step, index) => (step.members.some((member) => !canUpdateRecipient(member)) ? index : lastIndex),
    -1,
  );

/**
 * Dense-renumbers steps to 1..K while preserving groups (duplicate orders).
 *
 * Steps containing a locked recipient (per `canUpdateRecipient`) keep the
 * locked recipient's persisted order, and editable steps never collide into a
 * locked step's number.
 *
 * CC recipients get an undefined signing order and move to the tail. The
 * returned array is re-ordered by step sequence.
 */
export const normalizeGroupedSigningOrders = <T extends GroupableRecipient>(
  recipients: T[],
  canUpdateRecipient: (recipient: T) => boolean = () => true,
): Array<T & { signingOrder?: number }> => {
  const { steps, ccRecipients } = groupRecipientsBySigningOrder(recipients);

  const lastLockedStepIndex = getLastLockedStepIndex(steps, canUpdateRecipient);

  let nextOrder = 1;

  const normalizedSteps = steps.map((step, index) => {
    // Locked steps hold persisted orders. Keep them exactly as they are, even
    // when sparse — renumbering them is what the server refuses.
    if (index <= lastLockedStepIndex) {
      const order = step.order === UNORDERED ? undefined : step.order;

      if (order !== undefined) {
        nextOrder = Math.max(nextOrder, order + 1);
      }

      return { order, members: step.members };
    }

    const order = nextOrder;

    nextOrder += 1;

    return { order, members: step.members };
  });

  return [
    ...normalizedSteps.flatMap((step) => step.members.map((member) => ({ ...member, signingOrder: step.order }))),
    ...ccRecipients.map((recipient) => ({ ...recipient, signingOrder: undefined })),
  ];
};

type EditorRecipient = GroupableRecipient & { formId: string };

/**
 * Merges all members of the source step into the target step.
 */
export const mergeSteps = <T extends EditorRecipient>(
  recipients: T[],
  sourceStepIndex: number,
  targetStepIndex: number,
  canUpdateRecipient?: (recipient: T) => boolean,
): Array<T & { signingOrder?: number }> => {
  const { steps } = groupRecipientsBySigningOrder(recipients);

  const sourceStep = steps[sourceStepIndex];
  const targetStep = steps[targetStepIndex];
  const lastLockedStepIndex = getLastLockedStepIndex(steps, canUpdateRecipient);

  if (
    !sourceStep ||
    !targetStep ||
    sourceStepIndex === targetStepIndex ||
    sourceStepIndex <= lastLockedStepIndex ||
    targetStepIndex <= lastLockedStepIndex
  ) {
    return normalizeGroupedSigningOrders(recipients, canUpdateRecipient);
  }

  const sourceFormIds = new Set(sourceStep.members.map((member) => member.formId));

  // Source members join after the target step's existing members.
  const remaining = recipients.filter((recipient) => !sourceFormIds.has(recipient.formId));
  const lastMemberFormId = targetStep.members[targetStep.members.length - 1].formId;
  const insertAfterIndex = remaining.findIndex((recipient) => recipient.formId === lastMemberFormId);

  const movedMembers = sourceStep.members.map((member) => ({ ...member, signingOrder: targetStep.order }));

  const updated = [
    ...remaining.slice(0, insertAfterIndex + 1),
    ...movedMembers,
    ...remaining.slice(insertAfterIndex + 1),
  ];

  return normalizeGroupedSigningOrders(updated, canUpdateRecipient);
};

/**
 * Moves a single recipient into the target step (joins the group).
 */
export const moveRecipientToStep = <T extends EditorRecipient>(
  recipients: T[],
  formId: string,
  targetStepIndex: number,
  canUpdateRecipient?: (recipient: T) => boolean,
): Array<T & { signingOrder?: number }> => {
  const { steps } = groupRecipientsBySigningOrder(recipients);

  const targetStep = steps[targetStepIndex];
  const mover = recipients.find((recipient) => recipient.formId === formId);
  const lastLockedStepIndex = getLastLockedStepIndex(steps, canUpdateRecipient);
  const moverStepIndex = steps.findIndex((step) => step.members.some((member) => member.formId === formId));

  if (!targetStep || !mover || isCcRecipient(mover)) {
    return normalizeGroupedSigningOrders(recipients, canUpdateRecipient);
  }

  // Neither the recipient nor the destination may sit in the locked region.
  if (targetStepIndex <= lastLockedStepIndex || moverStepIndex <= lastLockedStepIndex) {
    return normalizeGroupedSigningOrders(recipients, canUpdateRecipient);
  }

  if (targetStep.members.some((member) => member.formId === formId)) {
    return normalizeGroupedSigningOrders(recipients, canUpdateRecipient);
  }

  const remaining = recipients.filter((recipient) => recipient.formId !== formId);
  const lastMemberFormId = targetStep.members[targetStep.members.length - 1].formId;
  const insertAfterIndex = remaining.findIndex((recipient) => recipient.formId === lastMemberFormId);

  const updated = [
    ...remaining.slice(0, insertAfterIndex + 1),
    { ...mover, signingOrder: targetStep.order },
    ...remaining.slice(insertAfterIndex + 1),
  ];

  return normalizeGroupedSigningOrders(updated, canUpdateRecipient);
};

/**
 * Extracts a recipient into its own standalone step at the given gap position
 * (gap N sits before step N; an out-of-bounds gap appends to the end).
 */
export const extractRecipientToNewStep = <T extends EditorRecipient>(
  recipients: T[],
  formId: string,
  insertStepIndex: number,
  canUpdateRecipient?: (recipient: T) => boolean,
): Array<T & { signingOrder?: number }> => {
  const { steps } = groupRecipientsBySigningOrder(recipients);

  const mover = recipients.find((recipient) => recipient.formId === formId);

  if (!mover || isCcRecipient(mover)) {
    return normalizeGroupedSigningOrders(recipients, canUpdateRecipient);
  }

  const currentStepIndex = steps.findIndex((step) => step.members.some((member) => member.formId === formId));
  const isSoloStep = currentStepIndex !== -1 && steps[currentStepIndex].members.length === 1;
  const lastLockedStepIndex = getLastLockedStepIndex(steps, canUpdateRecipient);

  // Dropping a solo step into the gap directly above or below itself is a no-op.
  if (isSoloStep && (insertStepIndex === currentStepIndex || insertStepIndex === currentStepIndex + 1)) {
    return normalizeGroupedSigningOrders(recipients, canUpdateRecipient);
  }

  // Gap N sits before step N, so inserting at or before the last locked step
  // would land the recipient inside the locked region.
  if (insertStepIndex <= lastLockedStepIndex || currentStepIndex <= lastLockedStepIndex) {
    return normalizeGroupedSigningOrders(recipients, canUpdateRecipient);
  }

  const insertOrder =
    insertStepIndex >= steps.length ? (steps[steps.length - 1]?.order ?? 0) + 1 : steps[insertStepIndex].order - 0.5;

  const updated = recipients.map((recipient) =>
    recipient.formId === formId ? { ...recipient, signingOrder: insertOrder } : recipient,
  );

  return normalizeGroupedSigningOrders(updated, canUpdateRecipient);
};

/**
 * Moves a whole step (group) to a new position in the step sequence.
 *
 * Refused when either end sits in the locked region (see
 * `getLastLockedStepIndex`); only the unlocked tail can be rearranged.
 */
export const reorderStep = <T extends EditorRecipient>(
  recipients: T[],
  fromStepIndex: number,
  toStepIndex: number,
  canUpdateRecipient: (recipient: T) => boolean = () => true,
): Array<T & { signingOrder?: number }> => {
  const { steps, ccRecipients } = groupRecipientsBySigningOrder(recipients);

  const lastLockedStepIndex = getLastLockedStepIndex(steps, canUpdateRecipient);

  if (
    !steps[fromStepIndex] ||
    fromStepIndex === toStepIndex ||
    fromStepIndex <= lastLockedStepIndex ||
    toStepIndex <= lastLockedStepIndex
  ) {
    return normalizeGroupedSigningOrders(recipients, canUpdateRecipient);
  }

  const reorderedSteps = [...steps];
  const [movedStep] = reorderedSteps.splice(fromStepIndex, 1);

  reorderedSteps.splice(Math.min(toStepIndex, reorderedSteps.length), 0, movedStep);

  // Locked steps cannot be the source or destination, so they keep both their
  // position and their persisted order. The moved tail is numbered above the
  // highest locked order so it still sorts after them.
  const highestLockedOrder = reorderedSteps
    .slice(0, lastLockedStepIndex + 1)
    .reduce((highest, step) => (step.order === UNORDERED ? highest : Math.max(highest, step.order)), 0);

  const updated = [
    ...reorderedSteps.flatMap((step, index) => {
      if (index <= lastLockedStepIndex) {
        return step.members;
      }

      const order = highestLockedOrder + (index - lastLockedStepIndex);

      return step.members.map((member) => ({ ...member, signingOrder: order }));
    }),
    ...ccRecipients,
  ];

  return normalizeGroupedSigningOrders(updated, canUpdateRecipient);
};

/**
 * The signing order changes needed to give every signing recipient a step of
 * their own, or an empty array when none share one.
 *
 * Used to repair an envelope that must not contain signing groups (AES/QES).
 * Recipients keep their relative sequence — ordered by signing order, ties
 * broken by id, matching how the server sorts them everywhere else — and are
 * renumbered densely from 1. Orders are only rewritten when a step is actually
 * shared, so a valid-but-sparse sequence is left alone.
 *
 * CC recipients are excluded: they never sign and carry no step.
 */
export const flattenRecipientGroups = <T extends Pick<Recipient, 'id' | 'role'> & { signingOrder?: number | null }>(
  recipients: T[],
): Array<{ id: number; signingOrder: number }> => {
  const signingRecipients = recipients
    .filter((recipient) => !isCcRecipient(recipient))
    .sort((a, b) => effectiveOrder(a) - effectiveOrder(b) || a.id - b.id);

  const sharesAStep = new Set(signingRecipients.map(effectiveOrder)).size !== signingRecipients.length;

  if (!sharesAStep) {
    return [];
  }

  const changes: Array<{ id: number; signingOrder: number }> = [];

  signingRecipients.forEach((recipient, index) => {
    const signingOrder = index + 1;

    if (recipient.signingOrder !== signingOrder) {
      changes.push({ id: recipient.id, signingOrder });
    }
  });

  return changes;
};

type SignableRecipient = Pick<Recipient, 'role' | 'signingStatus'> & {
  signingOrder?: number | null;
};

/**
 * Whether it is the recipient's turn to act under SEQUENTIAL signing.
 *
 * A recipient may act iff no non-CC recipient with a strictly lower signing
 * order is still unsigned (rejected counts as unsigned/blocking). Recipients
 * sharing a signing order never block each other.
 *
 * Callers are responsible for checking the document is in SEQUENTIAL mode.
 */
export const isRecipientTurnBySigningOrder = <T extends SignableRecipient>(
  recipients: T[],
  currentRecipient: { signingOrder?: number | null },
): boolean => {
  const currentOrder = effectiveOrder(currentRecipient);

  return !recipients.some(
    (recipient) =>
      !isCcRecipient(recipient) &&
      recipient.signingStatus !== SigningStatus.SIGNED &&
      effectiveOrder(recipient) < currentOrder,
  );
};

/**
 * Returns every pending recipient sharing the lowest pending signing order —
 * the "active group".
 *
 * Pass the full recipient list: filtering happens here so every caller agrees
 * on what "pending" means. A recipient is pending when they are not a CC and
 * have not signed OR rejected — advancing to a rejected recipient would
 * re-activate and re-email somebody who declined to sign.
 */
export const filterRecipientsInFirstSigningGroup = <T extends SignableRecipient>(recipients: T[]): T[] => {
  const pendingRecipients = recipients.filter(
    (recipient) => !isCcRecipient(recipient) && recipient.signingStatus === SigningStatus.NOT_SIGNED,
  );

  if (pendingRecipients.length === 0) {
    return [];
  }

  const minOrder = Math.min(...pendingRecipients.map((recipient) => effectiveOrder(recipient)));

  return pendingRecipients.filter((recipient) => effectiveOrder(recipient) === minOrder);
};

/**
 * The single recipient that the current recipient may dictate (rename) on
 * completion, or null when dictation does not apply:
 *
 * - the current recipient must be the last unsigned member of their step, and
 * - the next step must contain exactly one recipient.
 */
export const getNextDictatableRecipient = <T extends SignableRecipient & Pick<Recipient, 'id'>>({
  recipients,
  currentRecipientId,
}: {
  recipients: T[];
  currentRecipientId: number;
}): T | null => {
  const currentRecipient = recipients.find((recipient) => recipient.id === currentRecipientId);

  if (!currentRecipient || isCcRecipient(currentRecipient)) {
    return null;
  }

  const currentOrder = effectiveOrder(currentRecipient);

  const hasUnsignedPeers = recipients.some(
    (recipient) =>
      recipient.id !== currentRecipientId &&
      !isCcRecipient(recipient) &&
      effectiveOrder(recipient) === currentOrder &&
      recipient.signingStatus !== SigningStatus.SIGNED,
  );

  if (hasUnsignedPeers) {
    return null;
  }

  // Only the step matters here; `filterRecipientsInFirstSigningGroup` drops
  // CCs and anyone who has already signed or rejected.
  const laterRecipients = recipients.filter((recipient) => effectiveOrder(recipient) > currentOrder);

  const nextStep = filterRecipientsInFirstSigningGroup(laterRecipients);

  if (nextStep.length !== 1) {
    return null;
  }

  return nextStep[0];
};

/**
 * Dissolves a group into consecutive standalone steps preserving relative order.
 */
export const ungroupStep = <T extends EditorRecipient>(
  recipients: T[],
  stepIndex: number,
  canUpdateRecipient?: (recipient: T) => boolean,
): Array<T & { signingOrder?: number }> => {
  const { steps } = groupRecipientsBySigningOrder(recipients);

  const step = steps[stepIndex];

  // Splitting a locked step would rewrite persisted orders.
  if (!step || step.members.length < 2 || stepIndex <= getLastLockedStepIndex(steps, canUpdateRecipient)) {
    return normalizeGroupedSigningOrders(recipients, canUpdateRecipient);
  }

  const offsetByFormId = new Map(step.members.map((member, index) => [member.formId, index]));

  const updated = recipients.map((recipient) => {
    const offset = offsetByFormId.get(recipient.formId);

    if (offset === undefined) {
      return recipient;
    }

    return { ...recipient, signingOrder: step.order + offset / (step.members.length + 1) };
  });

  return normalizeGroupedSigningOrders(updated, canUpdateRecipient);
};
