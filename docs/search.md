# Pango — Search

The header's search box: one request looks a text up across modules and answers a few results per group, so the client waits once instead of once per module. Code: `src/search/`. Read-only; no tables of its own.

## Endpoint

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /search?q=&limit=` | Any member; each group needs its own read permission | Up to `limit` (default 5, max 10) results per group, each group with the `total` of its matches. `q` is trimmed and takes 2 to 100 characters. |

Groups and what they match (case-insensitive, anywhere in the text):

| Group | Matches | Shows | Needs |
|---|---|---|---|
| `products` | SKU or name | Active products, by name | `catalog.read`, else `null` |
| `categories` | Name | Active and inactive, active first | `catalog.read`, else `null` |
| `warehouses` | Code or name | Active warehouses the user reads, by name | Never `null`: empty without `warehouse.read` anywhere (`warehouse.manage` reads all) |
| `alerts` | The product's SKU or name, or the warehouse's code or name | Open alerts, most severe first | `alert.read`, narrowed to the warehouses that grant it, else `null` |
| `users` | The member's name or email | Users the actor reads (as `GET /users`), active first | `user.read`, narrowed like `GET /users`, else `null` |

A `null` group means "you cannot read this", so the client hides it; an empty one means "nothing matched".

## Not done yet

- Ranking across groups (a match on the code first) and accent-insensitive matching.
- Searching movements and stock requests by number.
