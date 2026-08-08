# Break-glass access

Break-glass is an emergency control, not a bypass around authorization. The local contract in
`packages/policy/src/break-glass.ts` requires a human requester, a written reason, explicit
operation/resource scope, an expiration, an independent human approver, and a bounded use count.

1. Confirm the incident, tenant/workspace, affected resource, and the minimum exact operation.
2. Create a grant with the shortest useful expiration and the smallest positive use count.
3. Obtain approval from a different human. Do not share or copy a grant between subjects.
4. Consume the grant only at the side-effect boundary. Verify the operation and resource scope
   again immediately before use.
5. Revoke the grant as soon as the incident is resolved. Investigate any unexpected use count.
6. Verify the audit entries for request, approval, each use, expiration, and revocation.

Hosted deployments must bind this port to the selected identity provider, durable store, and
on-call workflow before production use. A grant never authorizes wildcard operations, cross-tenant
access, or raw secret disclosure.
