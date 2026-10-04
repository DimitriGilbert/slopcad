import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { awaitWorkbenchReady } from "./helpers";

/**
 * Phase 4.5 agent-chat accessibility stages (PLAN-AGENT-CHAT m7, D16):
 * the chat's four keyboard contracts on the REAL production build — the
 * composer keyboard journey (an unconfigured agent blocks sending with a
 * reason, and the walkthrough's settings opener is the keyboard path
 * out), the right-sidebar view-switch focus order (the panels' fields
 * leave the tab order while hidden and return on switch-back, the chat's
 * controls enter), the settings sheet's focus lifecycle (focus starts
 * inside the dialog, Escape restores the trigger), and the sidebar's
 * keyboard resize (the separator pattern: arrows/Home/End, clamped,
 * persisted across a reload).
 *
 * Pointer-free throughout — the journey never clicks, exactly like the
 * Phase 30 keyboard-journey discipline. The workbench example runs
 * unauthenticated, so the settings sheet's protected queries answer
 * errors; these stages assert focus and control semantics, never
 * populated model lists.
 */

const VIEW_PANELS = "right-sidebar-view-panels";
const VIEW_CHAT = "right-sidebar-view-chat";
const RESIZE_HANDLE = "right-sidebar-resize-handle";
const DOCK = "workbench-panels-dock";
const EMPTY_SETTINGS = "agent-chat-empty-open-settings";
const SETTINGS_DIALOG = "agent-settings-dialog";

test.beforeEach(async ({ page }) => {
  await page.goto("/workbench-complete");
  await awaitWorkbenchReady(page, test.info().project.name);
});

/**
 * Walks the tab order from the page's FIRST tabbable. The shared helper's
 * blur keeps the browser's sequential-focus starting point wherever focus
 * last sat (a toggle click mid-test would start the walk mid-page); this
 * walk anchors on the first tabbable so the collected order is the whole
 * page's — the first stop itself is the anchor and not collected.
 */
async function tabKeysFromStart(page: Page): Promise<string[]> {
  await page.evaluate(() => {
    const candidates = document.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    for (const element of candidates) {
      if (element.getClientRects().length > 0) {
        element.focus();
        return;
      }
    }
  });
  const stops: string[] = [];
  for (let index = 0; index < 130; index += 1) {
    await page.keyboard.press("Tab");
    const key = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null || element === document.body) return null;
      // The shared helper's identity rule, verbatim: the most specific
      // token wins, and <label for>-labeled fields (the parameter inputs)
      // resolve through their label text.
      const id = element.id;
      const fieldLabel =
        id === ""
          ? null
          : (document
              .querySelector(`label[for="${CSS.escape(id)}"]`)
              ?.textContent?.trim() ?? null);
      return (
        element.getAttribute("data-testid") ??
        element.getAttribute("data-tool-id") ??
        element.getAttribute("aria-label") ??
        fieldLabel ??
        `${element.tagName.toLowerCase()}:${(element.textContent ?? "").trim().slice(0, 24)}`
      );
    });
    if (key === null) break;
    stops.push(key);
  }
  return stops;
}

/** Keyboard-only switch to the chat view (fresh contexts start on panels). */
async function switchToChatByKeyboard(page: Page): Promise<void> {
  const chatToggle = page.getByTestId(VIEW_CHAT);
  await chatToggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(DOCK)).toHaveAttribute(
    "data-agent-view",
    "chat",
  );
}

test("composer keyboard journey: view switch, blocked send with reason, settings escape", async ({
  page,
}) => {
  await switchToChatByKeyboard(page);

  // The unconfigured composer blocks sending with its reason (D5) — the
  // textarea itself is disabled and names the reason through
  // aria-describedby, so a keyboard user learns WHY before anything else.
  const composer = page.getByLabel("Chat message");
  await expect(composer).toBeDisabled();
  const reasonId = await composer.getAttribute("aria-describedby");
  expect(reasonId).not.toBeNull();
  await expect(page.locator(`#${reasonId ?? ""}`)).toContainText(/settings/i);

  // The walkthrough's settings opener is the keyboard path out of the
  // blocked state: it opens the sheet (focus inside — asserted by the
  // settings stage) and Escape returns focus HERE for the next move.
  const opener = page.getByTestId(EMPTY_SETTINGS);
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(SETTINGS_DIALOG)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(SETTINGS_DIALOG)).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("sidebar view-switch focus order: panels leave, chat enters, back restores", async ({
  page,
}) => {
  // Panels view: the switch itself leads the dock, and the parameter
  // fields are reachable tab stops after it.
  const panelsKeys = await tabKeysFromStart(page);
  const switchIndex = panelsKeys.indexOf(VIEW_PANELS);
  expect(switchIndex).toBeGreaterThanOrEqual(0);
  expect(panelsKeys.indexOf(VIEW_CHAT)).toBe(switchIndex + 1);
  const translateX = panelsKeys.findIndex((key) =>
    key.startsWith("translate_x"),
  );
  expect(translateX).toBeGreaterThan(switchIndex);

  // Chat view: the hidden panels' fields LEAVE the tab order (display:
  // none — state preserved, D16) and the chat's own controls enter after
  // the switch. The panel settles (resume, store open) before the walk —
  // a walk across a mounting DOM loses stops.
  await switchToChatByKeyboard(page);
  await expect(page.getByTestId("agent-chat-panel")).toBeVisible();
  const chatKeys = await tabKeysFromStart(page);
  expect(chatKeys.indexOf(VIEW_PANELS)).toBeGreaterThanOrEqual(0);
  expect(
    chatKeys.findIndex((key) => key.startsWith("translate_x")),
    "hidden panels leave the tab order",
  ).toBe(-1);
  expect(
    chatKeys.indexOf("agent-chat-new"),
    "the chat header enters the tab order",
  ).toBeGreaterThan(chatKeys.indexOf(VIEW_CHAT));
  expect(
    chatKeys.indexOf(EMPTY_SETTINGS),
    "the walkthrough's settings opener is reachable",
  ).toBeGreaterThan(chatKeys.indexOf(VIEW_CHAT));

  // Back to panels: the fields return as tab stops again (their mounted
  // state never left — the same controls, not re-created ones).
  const panelsBack = page.getByTestId(VIEW_PANELS);
  await panelsBack.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(DOCK)).toHaveAttribute(
    "data-agent-view",
    "sidebar",
  );
  await expect(page.getByTestId("agent-chat-panel")).toHaveCount(0);
  await expect(page.getByLabel("translate_x", { exact: true })).toBeVisible();
  const restoredKeys = await tabKeysFromStart(page);
  expect(
    restoredKeys.findIndex((key) => key.startsWith("translate_x")),
    "the parameter fields return to the tab order",
  ).toBeGreaterThan(restoredKeys.indexOf(VIEW_PANELS));
});

test("settings sheet: keyboard open lands focus inside, Escape restores the trigger", async ({
  page,
}) => {
  await switchToChatByKeyboard(page);
  const opener = page.getByTestId(EMPTY_SETTINGS);
  await opener.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByTestId(SETTINGS_DIALOG);
  await expect(dialog).toBeVisible();
  const inside = await page.evaluate((selector) => {
    const element = document.querySelector(`[data-testid="${selector}"]`);
    return element !== null && element.contains(document.activeElement);
  }, SETTINGS_DIALOG);
  expect(inside, "focus starts inside the settings sheet").toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("keyboard sidebar resize: arrows step, Home/End clamp, size survives reload", async ({
  page,
}) => {
  const dock = page.getByTestId(DOCK);
  const handle = page.getByTestId(RESIZE_HANDLE);

  const ariaWidth = async (): Promise<number> => {
    const raw = await handle.getAttribute("aria-valuenow");
    expect(raw).not.toBeNull();
    return Number(raw ?? 0);
  };

  await handle.focus();

  // The separator pattern: ArrowLeft widens the right-anchored dock,
  // ArrowRight narrows it — one 16px step per press.
  const start = await ariaWidth();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(ariaWidth).toBe(start + 16);
  await page.keyboard.press("ArrowRight");
  await expect.poll(ariaWidth).toBe(start);

  // Home/End jump to the clamped extremes; at an extreme the arrow that
  // would leave the range stays clamped, the arrow back in steps freely.
  await page.keyboard.press("End");
  await expect.poll(ariaWidth).toBe(560);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(ariaWidth).toBe(560);
  await page.keyboard.press("ArrowRight");
  await expect.poll(ariaWidth).toBe(544);
  await page.keyboard.press("Home");
  await expect.poll(ariaWidth).toBe(200);
  await page.keyboard.press("ArrowRight");
  await expect.poll(ariaWidth).toBe(200);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(ariaWidth).toBe(216);

  // The inline width follows the handle's value, and the choice persists
  // across a reload with the layout state.
  const inlineWidth = await dock.evaluate((element) =>
    Number.parseFloat(
      (element as HTMLElement).style.width.replace("px", "") ?? "",
    ),
  );
  expect(Math.round(inlineWidth)).toBe(216);

  await page.reload();
  await awaitWorkbenchReady(page, test.info().project.name);
  await expect(
    page.getByTestId(RESIZE_HANDLE),
    "the resized width persists across reload",
  ).toHaveAttribute("aria-valuenow", "216");
});
