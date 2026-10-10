# Security architecture roadmap

This roadmap records planned work. Existing local sessions run with the host
user's authority; command and file policies do not provide OS containment.
OpenShell workers and RSI proof artifacts have additional boundaries, described
in their respective documentation.

| Work | Issue | Intended boundary |
| --- | --- | --- |
| Authenticated evidence journal | [#34](https://github.com/Capsize-Games/headlesscode/issues/34) | Collector persistence and signing keys remain outside worker write authority. |
| Contained execution profile | [#35](https://github.com/Capsize-Games/headlesscode/issues/35) | Operator policy is enforced by OpenShell without fallback to host execution. |
| Emergency controls | [#36](https://github.com/Capsize-Games/headlesscode/issues/36) | The supervisor can interrupt active work, revoke authority, and verify teardown. |
| Independent verification and incident disclosure | [#37](https://github.com/Capsize-Games/headlesscode/issues/37) | Evaluator expectations, decision logic, and signing keys remain outside candidate execution. |

Signed worker submissions remain worker-reported claims. Supervisor-observed
actions and independently executed checks must be identified separately.
Security pauses require explicit authorized resumption; ordinary cooperative
developer pauses retain their documented behavior.

The issues define failure behavior, required tests, integration ownership, and
the live runtime checks needed before making deployment claims. Passing mock
gateway tests alone does not establish live containment or multi-host operation.
