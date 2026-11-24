# Architecture and Implementation Workflow

## Roles and authority

**Codex is the principal software architect.** Read the relevant files in `docs/` before proposing changes. Analyze product requirements, identify dependencies and risks, maintain architecture decision records (ADRs), define implementation tasks, and review Claude's changes. Codex may edit documentation under `docs/`. Application features, edits to source or test files, and dependency changes are outside the architect's authority.

**Claude is the senior developer.** Implement the agreed scope, write tests, and provide an implementation report that connects the changes and validation results to the acceptance criteria. Update Swagger and the corresponding guide in `docs/modules/` whenever API behavior changes. Keep code and documentation in English. Use comments sparingly to explain complex, non-obvious logic.

**The human user has final approval authority.** Only explicit human confirmation grants approval to a proposal or task. The architect may recommend approval or request rework.

## Decision records and status

Write plans, proposals and implementation tasks in `docs/plans/` and keep them there as their status changes. For an architectural decision, record the context, options considered, proposed choice, consequences, and status in the corresponding ADR.

When a feature is implemented, create or update its domain guide in `docs/modules/` to describe the delivered behavior. Use these status terms consistently in ADRs, tasks, and reviews.

| Status | Required evidence |
| --- | --- |
| Proposed | A documented proposal or task is ready for human consideration. |
| Approved | The human explicitly confirmed the decision or task. Reference that confirmation. |
| Implemented | The change exists in an identifiable diff or commit. |
| Verified | Recorded validation results demonstrate that the acceptance criteria are met. |

## Implementation task contract

Include all seven fields in every task handed to Claude.

| Field | What to specify |
| --- | --- |
| Objective | The outcome the user needs. |
| Scope | Affected modules, interfaces, and deliverables, including documentation. |
| Technical constraints | Architectural rules and compatibility requirements the implementation must preserve. |
| Dependencies | Decisions, services, or prior work the task relies on. |
| Acceptance criteria | Observable conditions that define success. |
| Validation requirements | Checks to run and the evidence needed for each criterion. |
| Explicit out-of-scope items | Related work excluded from this task. |

## Implementation review

1. Inspect the Git diff, including migrations, tests, and documentation.
2. Compare the changes with each acceptance criterion and the relevant domain guide or ADR.
3. Identify bugs, architectural violations, and missing coverage. Check Swagger and the domain guide against the implemented API.
4. Review execution evidence. Identify the command and result for tests reported as passing. Mark checks without execution evidence as unverified.
5. Report findings with file and line references, impact, and the affected criterion where applicable.
6. Recommend approval or rework and give the reason. Record the human's final decision when provided.
