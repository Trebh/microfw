# Vision

Living document. Update it when a decision changes the direction; record the reasoning in the
commit or pull request that changes it.

## The problem

Front-end state machines and server workflows are usually written twice: once for the browser,
once for the backend, with a hand-written protocol in between. Moving a rule from one side to the
other (a credit check, a countdown, a validation) means rewriting it, and the two halves drift.

State-machine libraries such as XState solve the modelling half well, but they model state as a
fixed chart. SAM models it as data plus pure functions, which keeps business rules in plain code
and makes the control state a *derived* value rather than a declared one.

## The bet

µFW bets on three ideas together:

1. **SAM as the programming model.** Intents become proposals through actions (the only effectful
   part); acceptors decide what the model becomes; `state` derives the representation and its
   control state; `nap` proposes the next automatic action. Everything except actions is pure.
2. **Placement is a deployment decision.** Every cut point of the loop is an Effect `Schema`, and
   every box of the loop is a port with interchangeable local and remote adapters. Moving the model
   or the actions between browser and server is a change of `Layer`, never of domain code.
3. **The definition is the test oracle.** Because the step is pure, the control-state graph can be
   explored offline; each generated path is replayed against the real system — in-process, over an
   in-process RPC, through the rendered UI, or against a live server — asserting the representation
   at every node.

Effect 4 is the substrate: services and layers give dependency injection and inversion for free,
`Schema` makes parsing and the wire contract the same artefact, and typed errors keep failures
visible end to end.

## Principles

- **Hexagonal.** The SAM definition is the domain. Ports are Effect services; adapters are layers.
  Dependencies point inward: the domain never imports an adapter, a transport or a platform.
- **Parse, don't validate.** Untrusted data is decoded into domain types once, at the boundary.
  Inside, a value of a domain type is valid by construction.
- **Effects all the way down.** Code stays in `Effect`/`Stream` across layers and is run only at
  the edges: process entry points, DOM event handlers, test harnesses.
- **Boring and small.** Prefer a pure function to a service, and a service to a framework feature.
- **Observable by default.** Every step is recorded and can be replayed, travelled to, inspected.

## Where it is going

Near term. The open gaps, each with what done looks like, are in [docs/TODO.md](docs/TODO.md):

- A synchronised log that can be cut at a snapshot, refuses a checkpoint ahead of it, and fences
  the proposals of an instance that lost the automatic actions.
- Packages a consumer outside the workspace can install.

Longer term, µFW aims to compete with XState on its own ground — modelling, visualisation and
model-based testing — while keeping the domain as plain data and pure functions, and adding what a
chart library cannot: moving parts of the loop across the network without touching them.

## Non-goals

- A general-purpose UI framework. Views are pure functions of the representation; any renderer can
  be mounted the way `@mufw/view-uhtml` mounts uhtml.
- Hiding Effect. µFW is an Effect library and expects Effect in its users' code.
- Statecharts as the source of truth. Diagrams are derived from the definition, never the reverse.

## How we will know it works

- The example's placements (the four browser/server combinations of model and actions, and a web
  worker that holds both) run from one definition, with zero domain changes.
- The same path test passes locally, over in-process RPC and against a live server.
- A rule moved from client to server (or back) is a one-line layer change plus its test.
