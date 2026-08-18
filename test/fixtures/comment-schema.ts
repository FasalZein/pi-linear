export const LIVE_COMMENT_SCHEMA_2026_08_19 = {
  mutations: {
    commentCreate: {
      arguments: { input: 'CommentCreateInput!' },
      returns: 'CommentPayload!',
    },
    commentUpdate: {
      arguments: { skipEditedAt: 'Boolean', input: 'CommentUpdateInput!', id: 'String!' },
      returns: 'CommentPayload!',
    },
    commentResolve: {
      arguments: { id: 'String!', resolvingCommentId: 'String' },
      returns: 'CommentPayload!',
    },
    commentUnresolve: {
      arguments: { id: 'String!' },
      returns: 'CommentPayload!',
    },
  },
  inputs: {
    CommentCreateInput: {
      id: 'String',
      body: 'String',
      bodyData: 'JSON',
      issueId: 'String',
      projectUpdateId: 'String',
      initiativeUpdateId: 'String',
      postId: 'String',
      documentContentId: 'String',
      projectId: 'String',
      initiativeId: 'String',
      parentId: 'String',
      createAsUser: 'String',
      displayIconUrl: 'String',
      createdAt: 'DateTime',
      doNotSubscribeToIssue: 'Boolean',
      createOnSyncedSlackThread: 'Boolean',
      quotedText: 'String',
      subscriberIds: '[String!]',
    },
    CommentUpdateInput: {
      body: 'String',
      bodyData: 'JSON',
      resolvingUserId: 'String',
      resolvingCommentId: 'String',
      quotedText: 'String',
      subscriberIds: '[String!]',
      doNotSubscribeToIssue: 'Boolean',
    },
  },
  payload: {
    lastSyncId: 'Float!',
    comment: 'Comment!',
    success: 'Boolean!',
  },
} as const;
