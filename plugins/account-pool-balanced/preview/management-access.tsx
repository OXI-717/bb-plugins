import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ManagementAccessForm } from '../management-access-form';

const content = <main data-bb-plugin="account-pool-balanced"><ManagementAccessForm value="" pending={false} error={false} onChange={() => {}} onSubmit={event => event.preventDefault()} /></main>;
process.stdout.write('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><style>:root{--foreground:#171717;--background:#fff;--muted-foreground:#666;--input:#ddd;--ring:#555}*{box-sizing:border-box}h2,p{margin:0}body{font-family:system-ui;margin:0;background:#fafafa;color:#171717;padding:24px}main{max-width:620px;margin:auto;background:white;border:1px solid #ddd;border-radius:12px}input{box-sizing:border-box;width:100%}p{line-height:1.5}</style>' + renderToStaticMarkup(content) + '</html>');
