import type { RequirementBranch } from './operation-types';

/** Exact authored v0.4 compatibility requirement branches for all 48 operations. */
export const DEFINITION_COMPATIBILITY_BRANCHES: Readonly<Record<string, readonly RequirementBranch[]>> = {
  "list_comments": [
    {
      "all": []
    }
  ],
  "create_comment": [
    {
      "all": [],
      "exactlyOneOf": [
        [
          "issue",
          "issueId",
          "projectId",
          "initiativeId",
          "projectUpdateId",
          "initiativeUpdateId",
          "postId",
          "documentContentId",
          "parentId",
          "input.issueId",
          "input.projectId",
          "input.initiativeId",
          "input.projectUpdateId",
          "input.initiativeUpdateId",
          "input.postId",
          "input.documentContentId",
          "input.parentId"
        ],
        [
          "body",
          "bodyData",
          "input.body",
          "input.bodyData"
        ]
      ],
      "exactlyOneOfMessages": [
        "exactly one comment target is required",
        "exactly one of body or bodyData is required"
      ]
    }
  ],
  "update_comment": [
    {
      "all": [
        "id"
      ],
      "atLeastOneOf": [
        "body",
        "bodyData",
        "quotedText",
        "skipEditedAt",
        "doNotSubscribeToIssue",
        "resolvingUserId",
        "resolvingCommentId",
        "subscriberIds",
        "input.body",
        "input.bodyData",
        "input.quotedText",
        "input.doNotSubscribeToIssue",
        "input.resolvingUserId",
        "input.resolvingCommentId",
        "input.subscriberIds"
      ],
      "atLeastOneOfMessage": "at least one comment update field is required"
    }
  ],
  "list_views": [
    {
      "all": []
    }
  ],
  "get_view": [
    {
      "all": [
        "id"
      ]
    }
  ],
  "create_view": [
    {
      "all": [
        "name"
      ]
    }
  ],
  "update_view": [
    {
      "all": [
        "id"
      ]
    }
  ],
  "set_view_preferences": [
    {
      "all": [
        "viewId",
        "preferences"
      ]
    }
  ],
  "list_cycles": [
    {
      "all": []
    }
  ],
  "get_cycle": [
    {
      "all": [
        "cycle"
      ]
    },
    {
      "all": [
        "id"
      ]
    }
  ],
  "create_cycle": [
    {
      "all": [
        "team",
        "startsAt",
        "endsAt"
      ]
    },
    {
      "all": [
        "teamId",
        "startsAt",
        "endsAt"
      ]
    },
    {
      "all": [
        "teamKey",
        "startsAt",
        "endsAt"
      ]
    }
  ],
  "update_cycle": [
    {
      "all": [
        "id"
      ]
    }
  ],
  "list_documents": [
    {
      "all": []
    }
  ],
  "get_document": [
    {
      "all": [
        "document"
      ]
    },
    {
      "all": [
        "documentId"
      ]
    }
  ],
  "create_document": [
    {
      "all": [],
      "atLeastOneOf": [
        "title",
        "input.title"
      ]
    }
  ],
  "update_document": [
    {
      "all": [
        "documentId"
      ]
    }
  ],
  "list_initiatives": [
    {
      "all": []
    }
  ],
  "get_initiative": [
    {
      "all": [
        "initiative"
      ]
    },
    {
      "all": [
        "initiativeId"
      ]
    }
  ],
  "list_issue_labels": [
    {
      "all": []
    }
  ],
  "create_issue_label": [
    {
      "all": [],
      "atLeastOneOf": [
        "name",
        "input.name"
      ]
    }
  ],
  "update_issue_label": [
    {
      "all": [
        "id"
      ]
    }
  ],
  "list_issue_relations": [
    {
      "all": []
    }
  ],
  "create_issue_relation": [
    {
      "all": [
        "issue",
        "relatedIssue",
        "type"
      ]
    },
    {
      "all": [
        "issueId",
        "relatedIssueId",
        "type"
      ]
    },
    {
      "all": [
        "issueId",
        "relatedIssueId",
        "type"
      ]
    }
  ],
  "update_issue_relation": [
    {
      "all": [
        "id"
      ]
    }
  ],
  "list_issue_statuses": [
    {
      "all": []
    }
  ],
  "list_issues": [
    {
      "all": []
    }
  ],
  "get_issue": [
    {
      "all": [
        "issue"
      ]
    },
    {
      "all": [
        "teamKey",
        "number"
      ]
    }
  ],
  "create_issue": [
    {
      "all": [
        "title"
      ],
      "atLeastOneOf": [
        "team",
        "teamKey",
        "teamId",
        "parent",
        "input.teamId",
        "input.parentId"
      ]
    },
    {
      "all": [
        "input.title"
      ],
      "atLeastOneOf": [
        "team",
        "teamKey",
        "teamId",
        "parent",
        "input.teamId",
        "input.parentId"
      ]
    }
  ],
  "update_issue": [
    {
      "all": [
        "issue"
      ]
    },
    {
      "all": [
        "issueId",
        "stateId"
      ]
    }
  ],
  "search_issues": [
    {
      "all": [
        "term"
      ]
    }
  ],
  "list_milestones": [
    {
      "all": []
    }
  ],
  "get_milestone": [
    {
      "all": [
        "milestone"
      ]
    },
    {
      "all": [
        "milestoneId"
      ]
    }
  ],
  "list_project_labels": [
    {
      "all": []
    }
  ],
  "create_project_label": [
    {
      "all": [],
      "atLeastOneOf": [
        "name",
        "input.name"
      ]
    }
  ],
  "update_project_label": [
    {
      "all": [
        "id"
      ]
    }
  ],
  "list_project_relations": [
    {
      "all": []
    }
  ],
  "create_project_relation": [
    {
      "all": [
        "projectId",
        "relatedProjectId",
        "type",
        "anchorType",
        "relatedAnchorType"
      ]
    }
  ],
  "update_project_relation": [
    {
      "all": [
        "id"
      ]
    }
  ],
  "list_projects": [
    {
      "all": []
    }
  ],
  "get_project": [
    {
      "all": [
        "project"
      ]
    },
    {
      "all": [
        "projectId"
      ]
    }
  ],
  "list_teams": [
    {
      "all": []
    }
  ],
  "get_team": [
    {
      "all": [
        "team"
      ]
    },
    {
      "all": [
        "teamId"
      ]
    }
  ],
  "list_users": [
    {
      "all": []
    }
  ],
  "get_user": [
    {
      "all": [
        "user"
      ]
    },
    {
      "all": [
        "userId"
      ]
    }
  ],
  "switch_workspace": [
    {
      "all": [
        "name"
      ]
    }
  ],
  "save_initiative": [
    {
      "all": [
        "name"
      ],
      "forbidden": [
        "initiativeId",
        "customIdentifier",
        "input.customIdentifier",
        "frequencyResolution",
        "input.frequencyResolution",
        "trashed",
        "input.trashed",
        "updateReminderFrequency",
        "input.updateReminderFrequency",
        "updateReminderFrequencyInWeeks",
        "input.updateReminderFrequencyInWeeks",
        "updateRemindersDay",
        "input.updateRemindersDay",
        "updateRemindersHour",
        "input.updateRemindersHour"
      ],
      "mode": "create"
    },
    {
      "all": [
        "input.name"
      ],
      "forbidden": [
        "initiativeId",
        "customIdentifier",
        "input.customIdentifier",
        "frequencyResolution",
        "input.frequencyResolution",
        "trashed",
        "input.trashed",
        "updateReminderFrequency",
        "input.updateReminderFrequency",
        "updateReminderFrequencyInWeeks",
        "input.updateReminderFrequencyInWeeks",
        "updateRemindersDay",
        "input.updateRemindersDay",
        "updateRemindersHour",
        "input.updateRemindersHour"
      ],
      "mode": "create"
    },
    {
      "all": [
        "initiativeId"
      ],
      "atLeastOneOf": [
        "color",
        "input.color",
        "content",
        "input.content",
        "description",
        "input.description",
        "icon",
        "input.icon",
        "labelIds",
        "input.labelIds",
        "leadTeamId",
        "input.leadTeamId",
        "name",
        "input.name",
        "ownerId",
        "input.ownerId",
        "priority",
        "input.priority",
        "prioritySortOrder",
        "input.prioritySortOrder",
        "sortOrder",
        "input.sortOrder",
        "status",
        "input.status",
        "targetDate",
        "input.targetDate",
        "targetDateResolution",
        "input.targetDateResolution",
        "customIdentifier",
        "input.customIdentifier",
        "frequencyResolution",
        "input.frequencyResolution",
        "trashed",
        "input.trashed",
        "updateReminderFrequency",
        "input.updateReminderFrequency",
        "updateReminderFrequencyInWeeks",
        "input.updateReminderFrequencyInWeeks",
        "updateRemindersDay",
        "input.updateRemindersDay",
        "updateRemindersHour",
        "input.updateRemindersHour"
      ],
      "atLeastOneOfMessage": "No initiative update fields were provided.",
      "forbidden": [
        "id",
        "input.id"
      ],
      "mode": "update"
    }
  ],
  "save_milestone": [
    {
      "all": [
        "name"
      ],
      "atLeastOneOf": [
        "projectId",
        "input.projectId"
      ],
      "forbidden": [
        "milestoneId"
      ],
      "mode": "create"
    },
    {
      "all": [
        "input.name"
      ],
      "atLeastOneOf": [
        "projectId",
        "input.projectId"
      ],
      "forbidden": [
        "milestoneId"
      ],
      "mode": "create"
    },
    {
      "all": [
        "milestoneId"
      ],
      "atLeastOneOf": [
        "description",
        "input.description",
        "descriptionData",
        "input.descriptionData",
        "name",
        "input.name",
        "projectId",
        "input.projectId",
        "sortOrder",
        "input.sortOrder",
        "targetDate",
        "input.targetDate"
      ],
      "atLeastOneOfMessage": "No milestone update fields were provided.",
      "forbidden": [
        "id",
        "input.id"
      ],
      "mode": "update"
    }
  ],
  "save_project": [
    {
      "all": [
        "name"
      ],
      "atLeastOneOf": [
        "teamIds",
        "input.teamIds"
      ],
      "forbidden": [
        "projectId",
        "canceledAt",
        "input.canceledAt",
        "completedAt",
        "input.completedAt",
        "frequencyResolution",
        "input.frequencyResolution",
        "projectUpdateRemindersPausedUntilAt",
        "input.projectUpdateRemindersPausedUntilAt",
        "slackIssueComments",
        "input.slackIssueComments",
        "slackIssueStatuses",
        "input.slackIssueStatuses",
        "slackNewIssue",
        "input.slackNewIssue",
        "trashed",
        "input.trashed",
        "updateReminderFrequency",
        "input.updateReminderFrequency",
        "updateReminderFrequencyInWeeks",
        "input.updateReminderFrequencyInWeeks",
        "updateRemindersDay",
        "input.updateRemindersDay",
        "updateRemindersHour",
        "input.updateRemindersHour"
      ],
      "mode": "create"
    },
    {
      "all": [
        "input.name"
      ],
      "atLeastOneOf": [
        "teamIds",
        "input.teamIds"
      ],
      "forbidden": [
        "projectId",
        "canceledAt",
        "input.canceledAt",
        "completedAt",
        "input.completedAt",
        "frequencyResolution",
        "input.frequencyResolution",
        "projectUpdateRemindersPausedUntilAt",
        "input.projectUpdateRemindersPausedUntilAt",
        "slackIssueComments",
        "input.slackIssueComments",
        "slackIssueStatuses",
        "input.slackIssueStatuses",
        "slackNewIssue",
        "input.slackNewIssue",
        "trashed",
        "input.trashed",
        "updateReminderFrequency",
        "input.updateReminderFrequency",
        "updateReminderFrequencyInWeeks",
        "input.updateReminderFrequencyInWeeks",
        "updateRemindersDay",
        "input.updateRemindersDay",
        "updateRemindersHour",
        "input.updateRemindersHour"
      ],
      "mode": "create"
    },
    {
      "all": [
        "projectId"
      ],
      "atLeastOneOf": [
        "name",
        "input.name",
        "description",
        "input.description",
        "content",
        "input.content",
        "color",
        "input.color",
        "icon",
        "input.icon",
        "convertedFromIssueId",
        "input.convertedFromIssueId",
        "labelIds",
        "input.labelIds",
        "lastAppliedTemplateId",
        "input.lastAppliedTemplateId",
        "leadId",
        "input.leadId",
        "leadTeamId",
        "input.leadTeamId",
        "memberIds",
        "input.memberIds",
        "priority",
        "input.priority",
        "prioritySortOrder",
        "input.prioritySortOrder",
        "sortOrder",
        "input.sortOrder",
        "startDate",
        "input.startDate",
        "startDateResolution",
        "input.startDateResolution",
        "statusId",
        "input.statusId",
        "targetDate",
        "input.targetDate",
        "targetDateResolution",
        "input.targetDateResolution",
        "teamIds",
        "input.teamIds",
        "canceledAt",
        "input.canceledAt",
        "completedAt",
        "input.completedAt",
        "frequencyResolution",
        "input.frequencyResolution",
        "projectUpdateRemindersPausedUntilAt",
        "input.projectUpdateRemindersPausedUntilAt",
        "slackIssueComments",
        "input.slackIssueComments",
        "slackIssueStatuses",
        "input.slackIssueStatuses",
        "slackNewIssue",
        "input.slackNewIssue",
        "trashed",
        "input.trashed",
        "updateReminderFrequency",
        "input.updateReminderFrequency",
        "updateReminderFrequencyInWeeks",
        "input.updateReminderFrequencyInWeeks",
        "updateRemindersDay",
        "input.updateRemindersDay",
        "updateRemindersHour",
        "input.updateRemindersHour"
      ],
      "atLeastOneOfMessage": "No project update fields were provided.",
      "forbidden": [
        "id",
        "input.id",
        "templateId",
        "input.templateId",
        "useDefaultTemplate",
        "input.useDefaultTemplate",
        "slackChannelName",
        "input.slackChannelName"
      ],
      "mode": "update"
    }
  ]
};

export const DEFINITION_SEMANTIC_EXCEPTIONS: Readonly<Record<string, string>> = {
  create_comment: 'comment-value-types',
  update_comment: 'comment-value-types',
  create_document: 'nested-title-type',
  create_issue_label: 'nested-name-type',
  create_project_label: 'nested-name-type',
  list_issues: 'state-name-requires-team',
  create_issue: 'non-empty-title-and-team-or-parent',
  save_initiative: 'save-value-types',
  save_milestone: 'save-value-types',
  save_project: 'save-value-types',
};
