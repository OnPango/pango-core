# Documentation layout

**Status** · Implemented. The user approved this layout and requested its implementation.

## Objective and scope

Give readers one entry point under `docs/` and organize existing material by what they need to find. Keep the existing guide filenames and the content of the domain guides.

| Destination | Existing material or purpose |
| --- | --- |
| `docs/README.md` | Index of implemented modules, architecture, project information, plans and templates. The repository README links here. |
| `docs/modules/` | `auth.md`, `catalog.md`, `warehouses.md`, `movements.md`, `stock.md`, `stock-requests.md`, `demand.md`, `forecasting.md`, `replenishment.md`, `dashboard.md` and `search.md`. |
| `docs/architecture/` | `database.md`, including tenant isolation, schema conventions, provisioning and migrations. |
| `docs/project/` | `architecture-workflow.md` for how changes are approved and reviewed, and `project-context.md` for decisions, findings and open questions. |
| `docs/plans/` | Implementation plans and their status throughout their lifecycle. |
| `docs/templates/` | Reusable files such as `pango-standard-kardex-movement-history-import-v1.csv`. Identify the CSV as the standard movement history import template in the documentation index. |

## Implementation and validation

**Dependencies.** Human approval of the layout. Coordinate path updates in the root guides and source comments with their maintainers.

**Technical constraints.** Preserve pending edits and Markdown heading anchors. Move files and update their references together. Once a feature ships, document its behavior in the corresponding module guide and keep the plan in `docs/plans/`.

**Acceptance criteria.** The index is the only file at the root of `docs/`. Every existing guide and the CSV template is reachable from it. CU-11 remains documented under replenishment. CU-17 remains identified as a proposal. The repository README, contributor instructions, project workflow and source references use the new paths.

**Validation requirements.** Compare the file inventory before and after the move, verify relative links and anchors, and search the repository for the old paths, including references written as plain text.

**Out of scope.** API changes, implementation-status changes and rewriting module content.
