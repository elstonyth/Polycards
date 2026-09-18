# Mercur 2.3.3 security backport

The core patch backports the authorization fixes released in Mercur 2.3.5:

- [Reject client-supplied cart prices](https://github.com/mercurjs/mercur/pull/1546).
- [Require variants to belong to the product in the route](https://github.com/mercurjs/mercur/pull/1545).
- [Validate ownership of every customer added to or removed from a group](https://github.com/mercurjs/mercur/pull/1544).

Keep the patch until a coordinated Mercur >=2.3.5 / Medusa >=2.20.1 upgrade
includes the upstream migrations and compatibility checks. Remove the resolution
and patch together, keeping the regression tests in the API unit suite.
