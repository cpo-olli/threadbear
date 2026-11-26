import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

type Coordinator = { on: boolean; setup: string | null; thread: string | null; tab: string; state: string | null; tasks: { title: string; state: string }[] | null; documentShown: boolean; editing: { draft: string; reviewCurrent: string | null } | null; document: { state: string; notes: string } | null };
const coordinator = (d: unknown) => (d as { coordinator?: Coordinator }).coordinator;

Then('the coordinator experiment is {string}', async function (this: ThreadbearWorld, state: string) {
  await this.until(`coordinator experiment ${state}`, (d) => coordinator(d)?.on === (state === 'on'));
});

Then('the project hides its Add coordinator control', async function (this: ThreadbearWorld) {
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === "Add a coordinator that keeps this project's notes and work current"), false);
});

Then('the project offers its Add coordinator control', async function (this: ThreadbearWorld) {
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === "Add a coordinator that keeps this project's notes and work current"), true);
});

When('the coordinator setting is restored without a notification', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorExperiment', params: { on: true, notify: false } });
});

When("I open the project's Add coordinator dialog", async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: "Add a coordinator that keeps this project's notes and work current" });
});

Then('the Add coordinator dialog is open', async function (this: ThreadbearWorld) {
  await this.until('the Add coordinator dialog to open', (d) => Boolean(coordinator(d)?.setup));
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === 'Keep the project as it is'), true);
  assert.equal(labels.some((control) => control.label === "Start this project's coordinator using the chosen pool and model"), true);
});

When('I press Escape to dismiss the Add coordinator dialog', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'menu-key', key: 'escape' });
});

When('I cancel the Add coordinator dialog', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: 'Keep the project as it is' });
});

Then('the Add coordinator dialog is closed', async function (this: ThreadbearWorld) {
  await this.until('the Add coordinator dialog to close', (d) => coordinator(d)?.setup === null);
});

When("I add the project's coordinator", async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', tip: "Add a coordinator that keeps this project's notes and work current" });
  await this.app.do({ cmd: 'click', tip: "Start this project's coordinator using the chosen pool and model" });
});

When("I open the coordinator's {string} tab", async function (this: ThreadbearWorld, tab: string) {
  await this.app.do({ cmd: 'click', tip: `Show the project's ${tab.toLowerCase()}` });
});

Then("the coordinator's Done card has no Archive button", async function (this: ThreadbearWorld) {
  await this.until('the coordinator Done card', (d) => d.composer.card?.[0] === 'Done');
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === 'Archive this thread'), false);
});

Then('the ordinary Done card has its Archive button', async function (this: ThreadbearWorld) {
  await this.until('the ordinary Done card', (d) => d.composer.card?.[0] === 'Done');
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string }[];
  assert.equal(labels.some((control) => control.label === 'Archive this thread'), true);
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

When('the coordinator checks and accepts the helper result', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorVerify', params: {} });
});

async function scrollDocumentToBottom(world: ThreadbearWorld): Promise<void> {
  await world.until('the shared project document', (d) => Boolean(coordinator(d)?.documentShown));
  const size = /([\d.]+)x([\d.]+)/.exec(await world.app.do({ cmd: 'window' }));
  if (!size) throw new Error('The window did not give its size');
  await world.app.do({ cmd: 'point', x: Number(size[1]) - 100, y: Number(size[2]) / 2, scrollY: -2000 });
}

When('I edit the project notes and add {string}', async function (this: ThreadbearWorld, text: string) {
  await scrollDocumentToBottom(this);
  await this.app.do({ cmd: 'click', tip: 'Edit the notes (or double-click it)' });
  await this.app.do({ cmd: 'type', here: true, text: `\n${text}` });
});

When('the coordinator changes the saved notes to {string}', async function (this: ThreadbearWorld, text: string) {
  await this.app.do({ cmd: 'mock', method: 'coordinatorNotesChanged', params: { text } });
});

When('I save the project text', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'menu-key', key: 'enter', modifiers: ['cmd'] });
});

Then('the project editor shows the current version {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until('the current saved text beside the draft', (d) => coordinator(d)?.editing?.reviewCurrent === text);
});

Then('the project editor still contains {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until('the preserved draft', (d) => coordinator(d)?.editing?.draft.includes(text));
});

When('I acknowledge the current project text', async function (this: ThreadbearWorld) {
  await scrollDocumentToBottom(this);
  await this.app.do({ cmd: 'click', tip: 'Keep my draft and compare its next save against this saved version' });
});

When('I append {string} to the project draft', async function (this: ThreadbearWorld, text: string) {
  await this.app.do({ cmd: 'type', here: true, text: `\n${text}` });
});

Then('the project notes contain {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until('the merged saved notes', (d) => coordinator(d)?.documentShown && coordinator(d)?.document?.notes.includes(text));
});

Then('the project editor is closed', async function (this: ThreadbearWorld) {
  await this.until('the editor closed after saving', (d) => Boolean(coordinator(d)) && coordinator(d)?.editing === null);
});
