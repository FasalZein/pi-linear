export type CanonicalVariant = {
  fields: readonly string[];
  branches: readonly (readonly string[])[];
};

export type CanonicalOperation = {
  fields: Readonly<Record<string, string>>;
  branches: readonly (readonly string[])[];
  /** Require exactly one branch, rather than at least one branch. */
  exclusiveBranches?: true;
  /** Closed, mutually exclusive object shapes for mode-sensitive operations. */
  variants?: readonly [CanonicalVariant, CanonicalVariant];
};

/** Fields excluded from every typed schema, with the reason. */
export const TYPED_EXCLUSIONS = {
  /** Arbitrary raw input stays on the compatibility surface. */
  rawInput: ['input'],
  /** The canonical typed contract publishes one identity name per concept. */
  identityAliases: ['issueId', 'teamKey', 'stateId', 'stateName', 'assigneeId', 'parentId'],
  /** `trashed` is the delete path in field form. */
  destructive: ['trashed'],
} as const;
