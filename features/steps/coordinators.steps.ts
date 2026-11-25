import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

type Coordinator = { on: boolean; thread: string | null; tab: string; state: string | null; tasks: { title: string; state: string }[] | null; documentShown: boolean; document: { state: string } | null };
const coordinator = (d: unknown) => (d as { coordinator?: Coordinator }).coordinator;

When("I add the project's coordinator", async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: "Add a coordinator that keeps this project's notes and work current" });
  await this.app.do({ cmd: 'click', tip: "Start this project's coordinator using the chosen pool and model" });
});

When("I open the coordinator's {string} tab", async function (this: ThreadbearWorld, tab: string) {
  await this.app.do({ cmd: 'click', tip: `Show the project's ${tab.toLowerCase()}` });
});

Then("the coordinator's {string} tab is open", async function (this: ThreadbearWorld, tab: string) {
  await this.until(`the ${tab} coordinator tab`, (d) => Boolean(coordinator(d)?.thread) && coordinator(d)?.tab === tab);
});

Then('the coordinator is listed once in its own sidebar section', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  const id = coordinator(d)?.thread;
  assert.ok(id, 'the project coordinator is open');
  const sections = d.sidebar.sections.filter((s) => s.threads.some((t) => t.id === id));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'Coordinators');
});

Then("the coordinator's document contains {string}", async function (this: ThreadbearWorld, text: string) {
  await this.until(`shared project state containing ${text}`, (d) => coordinator(d)?.documentShown && coordinator(d)?.document?.state.includes(text));
});

Then('the coordinator has the to-do {string} in {string}', async function (this: ThreadbearWorld, title: string, state: string) {
  await this.until(`the ${title} to-do ${state}`, (d) => coordinator(d)?.tasks?.some((t) => t.title === title && t.state === state));
});

When('I pause the project coordinator', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Pause or resume the coordinator and its helpers' });
});

Then('the project coordinator is {string}', async function (this: ThreadbearWorld, state: string) {
  await this.until(`coordinator ${state}`, (d) => coordinator(d)?.state === state);
});

When('a coordinator helper finishes its work', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorFinish', params: {} });
});
