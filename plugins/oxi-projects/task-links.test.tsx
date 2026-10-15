// @vitest-environment jsdom
import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
const {navigate} = vi.hoisted(() => ({navigate: {toPluginPanel: vi.fn(), openThreadPanel: vi.fn(() => true)}}));
vi.mock('@get-bb/plugin-sdk/app', () => ({useBbNavigate: () => navigate}));
import {ProjectTaskLink} from './task-links-view';
import {taskLinkDirective, taskLinkInstructions, parseTaskPanelTarget, taskItemSubPath} from './task-links';
afterEach(() => {cleanup(); vi.clearAllMocks(); navigate.openThreadPanel.mockReturnValue(true);});
const message = {id:'m',threadId:'t',turnId:'turn',projectId:'proj_current'};
it('opens the explicitly named project even when the chat belongs to another project', () => {
 render(<ProjectTaskLink attributes={{project:'proj_target',source:'linear',locator:'ABC-42'}} source="literal" message={message} openWorkspaceFile={null}/>);
 expect(navigate.toPluginPanel).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button', {name:/ABC-42/}));
 expect(navigate.openThreadPanel).toHaveBeenCalledWith({actionId:'project-task-detail',title:'ABC-42',params:{projectId:'proj_target',source:'linear',locator:'ABC-42'}});
 expect(navigate.toPluginPanel).not.toHaveBeenCalled();
});
it('preserves arbitrary locators through directive and route encoding', () => {
 const locator = 'https://github.com/org/repo/issues/42?x=~% "}\n';
 const directive = taskLinkDirective({bbProjectId:'proj_target',source:'github',locator});
 const encoded = /locator="([^"]+)"/.exec(directive)![1];
 expect(decodeURIComponent(encoded)).toBe(locator);
 expect(directive.split('\n')).toHaveLength(1);
 render(<ProjectTaskLink attributes={{project:'proj_target',source:'github',locator:encoded}} source={directive} message={message} openWorkspaceFile={null}/>);
 fireEvent.click(screen.getByRole('button'));
 expect(navigate.openThreadPanel.mock.calls[0][0].params.locator).toBe(locator);
 expect(navigate.toPluginPanel).not.toHaveBeenCalled();
});
it.each([
 {source:'linear',locator:'ABC-42'},
 {project:'proj_target',source:'unknown',locator:'ABC-42'},
 {project:'proj_target',source:'linear',locator:'%ZZ'},
 {project:'../evil',source:'linear',locator:'ABC-42'},
 {project:'proj_target',source:'linear',locator:'a'.repeat(2001)},
])('keeps invalid or ambiguous references inert: %j', attributes => {
 render(<ProjectTaskLink attributes={attributes} source="original directive" message={message} openWorkspaceFile={null}/>);
 expect(screen.queryByRole('button')).toBeNull();
 expect(screen.getByText('original directive')).toBeTruthy();
 expect(navigate.toPluginPanel).not.toHaveBeenCalled();
});
it('gives agents the explicit current project, verification command and no-guessing rule', () => {
 const instructions = taskLinkInstructions('proj_current');
 expect(instructions).toContain('project="proj_current"');
 expect(instructions).toContain('bb project-work show');
 expect(instructions).toContain('исходный locator БЕЗ encodeURIComponent');
 expect(instructions).toContain('Не угадывай');
});

it('shows an inline error if the host declines the side panel and keeps the thread in place', () => {
 navigate.openThreadPanel.mockReturnValue(false);
 render(<ProjectTaskLink attributes={{project:'proj_target',source:'linear',locator:'ABC-42'}} source="literal" message={message} openWorkspaceFile={null}/>);
 fireEvent.click(screen.getByRole('button'));
 expect(screen.getByRole('alert').textContent).toContain('Боковая панель');
 expect(navigate.toPluginPanel).not.toHaveBeenCalled();
});

it('restores only valid panel targets and preserves raw locators without re-decoding', () => {
 const target = {projectId:'proj_target',source:'github' as const,locator:'o/r#1?x=~%'};
 expect(parseTaskPanelTarget(JSON.parse(JSON.stringify(target)))).toEqual(target);
 const route = taskItemSubPath(target);
 expect(decodeURIComponent(route.split('/')[3].replaceAll('~','%'))).toBe(target.locator);
 for (const params of [null,{}, {...target,projectId:'../bad'}, {...target,source:'autopilot'}, {...target,extra:'ignored'}]) {
  expect(parseTaskPanelTarget(params)).toBeNull();
 }
});
