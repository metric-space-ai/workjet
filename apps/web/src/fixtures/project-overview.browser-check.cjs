/* Run inside the admitted build lane against the isolated overview fixture. */
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const output = process.env.OVERVIEW_EVIDENCE_DIR;
const origin = process.env.OVERVIEW_FIXTURE_ORIGIN || "http://127.0.0.1:5749";

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const evidence = {
    fixture: "real ProjectOverviewView + ProjectOverviewQuestion; no backend or live profile",
    source: process.env.OVERVIEW_HEAD_SHA,
    cases: [],
  };
  try {
    for (const width of [1440, 420])
      for (const variant of ["molecularity", "full"]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          locale: "de-DE",
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.goto(`${origin}/project-overview-fixture.html?variant=${variant}`, {
          waitUntil: "networkidle",
        });
        await page.locator("[data-workjet-project-overview]").waitFor();
        const measured = await page.evaluate(() => {
          const main = document.querySelector("[data-workjet-project-overview]");
          const rect = (element) => {
            const r = element.getBoundingClientRect();
            return {
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              width: r.width,
              height: r.height,
            };
          };
          const kpis = [...main.querySelectorAll("[data-workjet-overview-kpi]")].map((element) => ({
            id: element.dataset.workjetOverviewKpi,
            value: element.querySelector("dd").textContent.trim(),
            bounds: rect(element),
          }));
          const goals = main.querySelector('[data-workjet-overview-section="goals"]');
          const row = goals.querySelector('[role="row"]:last-child');
          const firstRow = goals.querySelector('[role="row"]:nth-child(2)');
          const decision = main.querySelector('[data-workjet-overview-section="decisions"]');
          return {
            forbiddenCaptions: /not yet available|noch nicht verfügbar/i.test(main.textContent),
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
            h1: rect(main.querySelector("h1")),
            meeting: rect(main.querySelector('[data-workjet-overview-section="meeting"]')),
            meetingText: main.querySelector('[data-workjet-overview-section="meeting"]').innerText,
            join: rect(main.querySelector('[data-workjet-action="project.jour-fixe.open"]')),
            tick: main.querySelector("[data-workjet-supervisor-tick]").innerText,
            kpis,
            decisions: decision
              ? { bounds: rect(decision), buttons: decision.querySelectorAll("button").length }
              : null,
            alerts: [...main.querySelectorAll("[data-workjet-overview-alert]")].map((element) => ({
              kind: element.dataset.workjetOverviewAlert,
              bounds: rect(element),
            })),
            goalsTop: rect(goals).top,
            firstGoal: rect(firstRow),
            stacked:
              row.querySelectorAll('[role="cell"]')[0].getBoundingClientRect().bottom <=
              row.querySelectorAll('[role="cell"]')[1].getBoundingClientRect().top,
            colors: [
              ...new Set(
                [...main.querySelectorAll("[data-workjet-overview-status]")].map(
                  (element) => element.dataset.workjetOverviewStatus,
                ),
              ),
            ],
            owners: [...main.querySelectorAll("[data-workjet-overview-owner]")].map((element) => ({
              text: element.innerText,
              bounds: rect(element),
              harnessMuted:
                !element.querySelector("span.block") ||
                element.querySelector("span.block").classList.contains("text-muted-foreground"),
            })),
            history: [...main.querySelectorAll("[data-workjet-overview-event]")].map((element) => ({
              id: element.dataset.workjetOverviewEvent,
              text: element.innerText,
            })),
            facts: main.querySelector("[data-workjet-overview-facts]").innerText,
            factLists: main.querySelectorAll("[data-workjet-overview-facts]").length,
            rawDetails: main.querySelectorAll("pre").length,
            diagnosisOpen: main.querySelector('[data-workjet-overview-section="diagnosis"]').open,
          };
        });
        assert.equal(measured.forbiddenCaptions, false, "criterion 1");
        assert.equal(measured.kpis.length, 5, "five metric tiles");
        assert.ok(
          measured.kpis.every((kpi) => kpi.value.length > 0),
          "criterion 4",
        );
        assert.ok(measured.documentWidth <= width, "criterion 9: horizontal overflow");
        assert.ok(
          measured.alerts.every((alert) => alert.bounds.bottom <= measured.goalsTop),
          "criterion 6: alerts above goals",
        );
        assert.ok(measured.alerts.some((alert) => alert.kind === "disruption"));
        assert.ok(
          measured.owners.every(
            (owner) =>
              !owner.text.includes("Molecularity") &&
              owner.bounds.height <= 36 &&
              owner.harnessMuted,
          ),
          "criterion 8",
        );
        assert.ok(
          measured.history.length <= 5 &&
            measured.history.filter((event) => event.id === "setup").length <= 1,
          "criterion 7",
        );
        assert.ok(
          measured.history.every(
            (event) => !/was created as|wurde als|a Persistent Workers/.test(event.text),
          ),
          "setup grammar",
        );
        assert.equal(measured.factLists, 1, "criterion 10");
        assert.equal(measured.rawDetails, 0, "criterion 11");
        assert.equal(measured.diagnosisOpen, false, "diagnosis collapsed");
        if (variant === "molecularity") {
          assert.equal(measured.decisions, null, "criterion 5");
          assert.ok(measured.facts.includes("—"));
        } else {
          assert.ok(measured.decisions.buttons > 0);
          assert.deepEqual(measured.colors.sort(), ["amber", "blue", "gray", "green", "red"]);
          assert.equal(measured.kpis.find((kpi) => kpi.id === "tokens").value, "1.8/2.3B (78 %)");
        }
        if (width === 1440) {
          assert.ok(
            [
              measured.h1,
              measured.meeting,
              measured.join,
              measured.firstGoal,
              ...measured.kpis.map((kpi) => kpi.bounds),
            ].every((bounds) => bounds.bottom <= 900),
            "criterion 3: above fold",
          );
        } else assert.equal(measured.stacked, true, "criterion 9: stacked goals");
        const screenshot = `${variant}-${width}x900.png`;
        await page.screenshot({ path: path.join(output, screenshot), fullPage: width === 420 });
        await page.getByRole("button", { name: "Jour fixe beitreten", exact: true }).click();
        assert.equal(
          await page.locator("[data-fixture-action]").getAttribute("data-fixture-action"),
          "meeting",
        );
        await page.getByRole("button", { name: "Pinball World Engine", exact: true }).click();
        assert.equal(
          await page.locator("[data-fixture-action]").getAttribute("data-fixture-action"),
          "chat:pinball",
        );
        // „Projekt & Einstellungen“ ist ersatzlos weg; Worker entstehen per Plus in der Seitenleiste.
        assert.equal(await page.locator('[data-workjet-overview-section="settings"]').count(), 0);
        if (variant === "full") {
          await page.getByRole("button", { name: "Ausliefern", exact: true }).click();
          await page.getByRole("button", { name: "Antworten", exact: true }).click();
          assert.equal(
            await page.locator("[data-fixture-action]").getAttribute("data-fixture-action"),
            "answer",
          );
        }
        await page.locator('[data-workjet-overview-section="diagnosis"] > summary').click();
        assert.equal(
          await page.locator('[data-workjet-overview-section="diagnosis"]').getAttribute("open"),
          "",
        );
        await page.locator('[data-workjet-overview-section="diagnosis"] > summary').click();
        await page.reload({ waitUntil: "networkidle" });
        assert.equal(
          await page.locator('[data-workjet-overview-section="diagnosis"]').getAttribute("open"),
          null,
        );
        assert.deepEqual(errors, [], "browser errors");
        evidence.cases.push({
          variant,
          width,
          height: 900,
          screenshot,
          measured,
          errors,
          interactions: [
            "meeting callback",
            "worker chat callback",
            "add worker callback",
            "diagnosis open/close",
            "reload",
            ...(variant === "full" ? ["answer real question form"] : []),
          ],
          pass: true,
        });
        await context.close();
      }
    for (const language of ["de", "en"]) {
      const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
      const page = await context.newPage();
      await page.goto(
        `${origin}/project-overview-fixture.html?variant=empty&language=${language}&disconnected=1`,
        { waitUntil: "networkidle" },
      );
      assert.equal(await page.locator('[data-workjet-overview-section="decisions"]').count(), 0);
      assert.equal(
        await page.locator("[data-workjet-overview-kpi] > dd").filter({ hasText: "—" }).count(),
        5,
      );
      assert.ok(
        !/not yet available|noch nicht verfügbar/i.test(await page.locator("main").textContent()),
      );
      assert.equal(await page.locator("[data-workjet-overview-connection]").count(), 1);
      evidence.cases.push({ variant: "empty-disconnected", language, width: 420, pass: true });
      await context.close();
    }
    await fs.writeFile(
      path.join(output, "browser-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log("Overview browser acceptance: 6 cases passed; 4 screenshots captured.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
