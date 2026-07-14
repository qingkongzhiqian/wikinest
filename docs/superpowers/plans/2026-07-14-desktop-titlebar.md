# Desktop Titlebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Electron sidebar toggle beside the macOS traffic lights in a dedicated clickable titlebar, without adding history controls.

**Architecture:** Electron uses a hidden native titlebar with visible traffic lights and a Web-rendered drag region. Desktop and browser render separate toggle buttons wired through one shared selector; desktop search remains on the second row.

**Tech Stack:** Electron BrowserWindow, embedded HTML/CSS/JavaScript, Node.js test runner.

---

### Task 1: Specify the titlebar structure

**Files:**
- Modify: `test/page-layout.test.js`

- [ ] Change the desktop navigation test to assert that `#sideCollapse` is inside `#desktopTitlebar`, that the browser fallback `#webSideCollapse` remains inside `.nav-inner`, and that no forward/back controls exist.
- [ ] Run `node --test test/page-layout.test.js` and verify failure because the titlebar does not exist.

### Task 2: Implement the custom titlebar

**Files:**
- Modify: `src/web/page.js`
- Modify: `desktop/main.js`

- [ ] Add a desktop-only fixed 44px `#desktopTitlebar` with a draggable background and a `no-drag` sidebar toggle positioned after the traffic lights.
- [ ] Rename the toolbar toggle to `#webSideCollapse`, hide it under `html.desktop`, and wire both buttons with `[data-sidebar-toggle]`.
- [ ] Remove the old pseudo-element drag layer from the sidebar and offset the desktop nav below the titlebar.
- [ ] Change BrowserWindow to `titleBarStyle: 'hidden'` and set `trafficLightPosition: { x: 16, y: 14 }`.
- [ ] Run focused and complete tests, syntax checks, lint, and `git diff --check`.
