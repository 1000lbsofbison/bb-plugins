# Aside

A sidenav for BB: projects, sections and threads. Focus comes from **order** and
**collapsing** — and, where you say so yourself, from **tags**.

Replaces BB's thread list through the sidebar slot.

## Install

```sh
bb plugin install git:https://github.com/sajov/bb-plugins.git \
  --subdirectory bb-plugin-aside
```

Then enable it under **Settings -> Appearance -> Sidebar -> Aside (Projects)**.

## Why no state filter

A filter on state removes rows you did not ask to lose. With eight running
threads "Working" is nearly the whole list, and "Needs you" is the one row
without its context — both extremes are useless, and both change on their own
while you are reading. Aside orders and condenses instead:

- **Dragging** reorders projects. Written through `projects.reorder`, so it is
  host-side and the same order on every device.
- **Clicking** the project row expands and collapses it, **Alt-click** leaves
  only that project open.
- **The fold button** in the header folds every project and unfolds them again —
  one button, because it is one gesture with two directions. `⌥C` and `⌥⇧C` do
  the same from the keyboard.
- **Condense quiet ones** turns silent threads into a single row `... 3 quiet`.
  Nothing disappears, it only gets smaller.
- **Show archived** is the only switch in the View menu that adds something.

Two controls do narrow the list, and both of them narrow whole projects rather
than the threads inside one:

- **Tags** — the funnel in the header, see below. You set the tags yourself, so
  the result is a list you meant rather than one derived from a state nobody
  chose.
- **Search** — the magnifier in the header opens a one-line slot between the
  menu bar and the list that filters on the project name. `⌥F` opens it and puts
  the caret in it, `Esc` clears the query and a second `Esc` closes the slot.
  Matching works the way bb's own search does on a list of names: case and
  accents are ignored, and several words are an AND in any order, so `studio
  graph` finds "Graph Studio". Nothing is fuzzy — in a list you navigate by
  muscle memory, a typo landing on the wrong project costs more than a query
  that simply finds nothing. The query is never stored: it is a question you are
  asking now, not a setting, and a saved search would greet you on the next
  device as a sidenav with projects missing.

## The rules

| Rule | Why |
| --- | --- |
| Colour says two things: amber "waiting for you", red "failed" | Everything else carries greyscale and shape. "Working" carries the motion. Amber rather than the accent blue, so a question survives a glance across a long list without borrowing the colour of failure. |
| Every row carries a mark — always, `quiet` included | Five states, exhaustive: working, needs-you, failed, unread, quiet. A row without a mark reads as "state unknown" rather than "nothing pending". |
| "Needs you" is the largest mark on the list | It is the only state that stops progress until someone acts, and size is the part of a signal that survives peripheral vision. `unread` sits below it, `quiet` well below both. |
| The count is the toggle — on projects, sections and agents | No small chevron to hunt for in a long list. Filled means open. |
| The count hangs off the end of the title; age and mark sit at the right edge | A count is identity — how much is in here — so it travels with the text. Age and state are the row's current condition and stay together on the right. |
| The right-hand slots keep their width when empty, the count does not | On the right there is no anchor, so a missing age would pull the mark out of its column. Nothing lines up against the count, so a row without one just ends earlier. |
| A project's age is the newest activity inside it, children included | It sits beside a mark that summarises the whole family too. A project reading "3d" while an agent works in it would contradict its own mark. |
| Children hang off the indent, with no line and no frame | The indent already says it; a line next to it only repeats it. |
| The harness mark sits on the left, level with the project badge | Root threads do not indent, only their agents do. |
| An empty name never writes | An accidental Enter must not leave a project nameless. |
| No row is set larger than the row it lives in | Three type sizes for the whole list: 12px for projects and threads, 10px for section headings. Hierarchy comes from weight, colour and indent — a thread set larger than its own project inverts the nesting it sits in. |
| A collapsed project is drawn no fainter than an open one | Folding is not a lesser state. The fold shows in the count badge's fill and in the header arrow; fading avatar and name on top of that made half the list look disabled. |
| Deleting one thread goes through BB's dialog | It counts the child threads first, and one thread is the case the host handles well. |
| Deleting many goes through our own selection mode | BB's delete is not recursive — the agents below a deleted thread survive as new roots. Selection mode addresses every member itself, asks twice, and names the count. |

## Selection mode

The button beside the fold arrow in the header turns it on: every card and
every agent grows a checkbox, the whole row toggles it, and dragging pauses.
The bar at the bottom says how many are selected and offers *Delete*.

*Delete* does not delete. It asks first, and the question names what will
actually go: the threads you picked plus the agents hanging below them. Only
the second press deletes.

It exists because of a measured host bug (bb 0.43.1, 15.09.2026): deleting a
thread deletes **that thread only**. Its children survive with
`parent_thread_id` set to NULL and reappear in the list as roots of their own.
`childThreadsConfirmed: true` is a confirmation receipt, not a cascade. The
`threads_delete` RPC therefore walks the real tree — archived and hidden
children included, because the sidenav cannot see those — and deletes children
before their parents.

## Tags

A project can carry tags, and the funnel in the header narrows the list to
them.

Tags are the plugin's own: bb 0.43's project model has no field for them
(`updateProject` carries a name and nothing else), so they sit in the plugin
database next to the project colours — host-wide, the same on every device.

- **Setting them** happens in the project's context menu, under *Tags*: the
  tags it carries sit at the top and come off with a click, the field below
  takes a new one on Enter, and every tag already in use elsewhere is offered
  as a chip underneath. Up to twelve per project, 24 characters each.
- **Stored lower case.** `Work` next to `work` is a duplicate you cannot tell
  apart in a list of chips, so the distinction is removed rather than kept.
- **The chips are grey.** Colour in this sidenav says two things, amber
  "waiting for you" and red "failed"; a palette of tag colours would spend the
  list's last signal on labels that already carry their own name.
- **The list never shows them.** A project row has a name, a count, an age and
  a mark, and that is the whole budget — tags would be a fifth thing on a
  32-pixel row that already fills its width.
- **Filtering** is the funnel in the header. Every tag carries the number of
  projects on it — the same count badge the rows use, filled while the tag is
  picked. Several tags are an OR: picking `api` and `web` asks for the projects
  carrying either. While it is on, the
  funnel fills and carries the count, because a filter you have forgotten about
  is a sidenav that appears to have lost projects.
- **The project you are working in always stays**, filtered or not: the thread
  in the pane next to it must have a row in the list it belongs to.
- **A tag that loses its last project stops filtering.** Otherwise the list
  would stay narrowed by something the menu no longer offers.

Filtering narrows whole projects, never the threads inside one. No thread ever
disappears out from under a project that stayed.

## Sections

In the host a section belongs to **no project** — its schema is only
`{ id, name }`, and threads point at it through `sectionId`. Aside therefore
shows it in every project where it has threads, and nowhere else.

You create one on a card: right-click -> *New section ...*. It comes into being
together with its first thread, because an empty section would be visible
nowhere. Further threads join through the menu or by dragging onto the section
row. *Dissolve* removes only the assignment; the message names the number of
threads affected.

## Dragging

- **Dragging the project row** reorders projects (`projects.reorder`).
- **A card onto the middle of a card** makes a sub-thread — the gesture BB has
  had in its own sidebar since 0.43
  (`threads.update({ parentThreadId })`).
- **A card onto the top or bottom edge of a card** reorders it there. The host
  keeps an order only for pinned threads, so **reordering pins** — visible by
  the pin, and the sidenav says so once.
- **A card onto a section row** puts it into that section. Through the context
  menu this works from any project, the personal one included.
- A thread never changes projects — `updateThread` has no `projectId`. Aside
  says so instead of swallowing it silently.

## Layout

| File | Contents |
| --- | --- |
| `lib/tree.ts` | Families, states, sorting, sections, condensing — without React |
| `lib/view.ts` | View state: parse, check, toggle, fold |
| `lib/colors.ts` | Project colour, automatic colour from the id, contrast |
| `lib/tags.ts` | Project tags: normalise, store, count, filter |
| `lib/search.ts` | Project-name search: normalise the query, fold, match |
| `lib/time.ts` | Relative ages for the right-hand column |
| `lib/badge.ts` | The count badge, shared by all three rows that carry one |
| `components/sidenav/row-slots.tsx` | The shared row slots: count in front, age and mark behind |
| `server.ts` | The writing host calls and three pieces of state we own |
| `components/sidenav/` | Sidenav, project row, card, section row, View menu, tag editor, tag filter and search slot |

The view state, the project colours and the project tags live in the server's
plugin database, not in `localStorage`: order, collapsed rows and tags should be
the same on every device.

## Developing

```sh
npx tsc --noEmit
npx vitest run
bb plugin build && bb plugin reload aside
```

## Credits

The card's grid — harness mark on the left, title and location in the middle,
time and state on the right — follows
[Dockside](https://github.com/MateoCerquetella/bb-plugins/tree/main/plugins/dockside)
by Mateo Cerquetella, which in turn took it from BB's `t3sidebar` example. What
is adopted is the model, not the code: Aside is a reimplementation against the
same SDK hooks.

## Requirements

- bb >= 0.43, plugin SDK >= 0.4.84
- Nothing else. No accounts, no keys, no services.

## Licence

[MIT](LICENSE)
