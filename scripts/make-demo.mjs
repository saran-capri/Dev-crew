// Builds ./demo-workspace: five small projects with real git repos in different stacks, so the
// crew has something to work on before you point the config at your own repos.
//   node scripts/make-demo.mjs          create it (skips projects that already exist)
//   node scripts/make-demo.mjs --reset  delete and recreate it
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../lib/config.mjs';

const WS = path.join(ROOT, 'demo-workspace');
if (process.argv.includes('--reset')) fs.rmSync(WS, { recursive: true, force: true });

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', ...args], { cwd, stdio: 'pipe' });

function repo(dir, files, extraBranches = []) {
  if (fs.existsSync(path.join(dir, '.git'))) return false;
  for (const [f, body] of Object.entries(files)) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body.replace(/^\n/, ''));
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  for (const b of extraBranches) git(dir, 'branch', b);
  return true;
}

const made = [];
const add = (p, files, branches) => { if (repo(path.join(WS, p), files, branches)) made.push(p); };

/* ---- Payments Portal: React web + Express API ---- */
add('payments-portal/web', {
  'package.json': `{
  "name": "payments-web", "private": true, "type": "module",
  "scripts": { "dev": "vite", "build": "tsc && vite build", "test": "vitest run" },
  "dependencies": { "react": "^18.3.0", "react-dom": "^18.3.0" },
  "devDependencies": { "typescript": "^5.5.0", "vite": "^5.4.0", "vitest": "^2.0.0" }
}
`,
  'src/App.tsx': `
import { InvoiceList } from './InvoiceList';

export default function App() {
  return (
    <main>
      <h1>Payments Portal</h1>
      <InvoiceList />
    </main>
  );
}
`,
  'src/InvoiceList.tsx': `
import { useEffect, useState } from 'react';

type Invoice = { id: string; customer: string; amount: number; status: 'paid' | 'due' | 'overdue' };

export function InvoiceList() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  useEffect(() => {
    fetch('/api/invoices').then(r => r.json()).then(setInvoices);
  }, []);
  // TODO: loading and error states, pagination
  return (
    <table>
      <tbody>
        {invoices.map(i => (
          <tr key={i.id} onClick={() => alert(i.id)}>
            <td>{i.customer}</td><td>{i.amount}</td><td>{i.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
`,
  'README.md': '# Payments web\n\nReact + Vite front end for the payments portal.\n',
}, ['develop']);
add('payments-portal/api', {
  'package.json': `{
  "name": "payments-api", "private": true, "type": "module",
  "scripts": { "start": "node src/server.js", "test": "node --test" },
  "dependencies": { "express": "^4.19.0" }
}
`,
  'src/server.js': `
import express from 'express';
import { listInvoices, getInvoice } from './invoices.js';

const app = express();
app.get('/api/invoices', (req, res) => res.json(listInvoices()));
app.get('/api/invoices/:id', (req, res) => res.json(getInvoice(req.params.id)));
app.listen(process.env.PORT || 3000);
`,
  'src/invoices.js': `
const invoices = [
  { id: 'INV-1001', customer: 'Acme Ltd', amount: 1200, status: 'paid' },
  { id: 'INV-1002', customer: 'Globex', amount: 860, status: 'due' },
  { id: 'INV-1003', customer: 'Initech', amount: 2400, status: 'overdue' },
];

export const listInvoices = () => invoices;
// BUG: returns undefined (and a 200) for an unknown id
export const getInvoice = id => invoices.find(i => i.id === id);
`,
  'test/invoices.test.js': `
import test from 'node:test';
import assert from 'node:assert';
import { listInvoices } from '../src/invoices.js';

test('lists invoices', () => assert.equal(listInvoices().length, 3));
`,
}, ['develop']);

/* ---- Inventory Service: .NET API + Terraform ---- */
add('inventory-service/api', {
  'Inventory.Api.csproj': `
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`,
  'Program.cs': `
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var stock = new Dictionary<string, int> { ["SKU-1"] = 40, ["SKU-2"] = 0 };

app.MapGet("/stock/{sku}", (string sku) => stock.TryGetValue(sku, out var n) ? Results.Ok(n) : Results.NotFound());
app.MapPost("/reserve/{sku}/{qty:int}", (string sku, int qty) =>
{
    // TODO: not thread-safe, no validation of qty
    stock[sku] -= qty;
    return Results.Ok(stock[sku]);
});

app.Run();
`,
});
add('inventory-service/infra', {
  'main.tf': `
terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.100" }
  }
}

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-inventory-\${var.env}"
  location = var.location
}

resource "azurerm_service_plan" "plan" {
  name                = "plan-inventory-\${var.env}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Linux"
  sku_name            = "P1v3"
}
`,
  'variables.tf': `
variable "env" { type = string }
variable "location" {
  type    = string
  default = "australiaeast"
}
`,
  'azure-pipelines.yml': `
trigger:
  - main
pool:
  vmImage: ubuntu-latest
steps:
  - script: terraform init -backend=false && terraform validate
    displayName: Validate
`,
});

/* ---- Analytics Platform: Python ETL + SQL migrations ---- */
add('analytics-platform/pipeline', {
  'requirements.txt': 'pandas==2.2.2\npsycopg[binary]==3.2.1\npytest==8.3.2\n',
  'etl/extract.py': `
import pandas as pd


def extract_orders(conn, since):
    # NOTE: string formatting into SQL
    return pd.read_sql(f"SELECT * FROM orders WHERE created_at > '{since}'", conn)
`,
  'etl/transform.py': `
def daily_revenue(df):
    df["day"] = df["created_at"].dt.date
    return df.groupby("day")["total"].sum().reset_index()
`,
  'tests/test_transform.py': `
import pandas as pd
from etl.transform import daily_revenue


def test_daily_revenue():
    df = pd.DataFrame({"created_at": pd.to_datetime(["2026-01-01", "2026-01-01"]), "total": [10, 5]})
    assert daily_revenue(df)["total"].tolist() == [15]
`,
});
add('analytics-platform/db', {
  'migrations/001_orders.sql': `
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  'migrations/002_customers.sql': `
CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  region TEXT
);
`,
  'queries/revenue_by_region.sql': `
SELECT c.region, SUM(o.total)
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.created_at > now() - interval '30 days'
GROUP BY c.region;
`,
});

/* ---- Customer App: Angular-style web + Spring Boot API ---- */
add('customer-app/web', {
  'package.json': `{
  "name": "customer-web", "private": true,
  "scripts": { "start": "ng serve", "test": "ng test --watch=false" },
  "dependencies": { "@angular/core": "^18.0.0", "@angular/common": "^18.0.0", "@angular/forms": "^18.0.0" }
}
`,
  'src/app/profile/profile.component.ts': `
import { Component } from '@angular/core';

@Component({
  selector: 'app-profile',
  template: \`
    <form>
      <input name="email" [(ngModel)]="email" />
      <button (click)="save()">Save</button>
    </form>
  \`,
})
export class ProfileComponent {
  email = '';
  save() {
    // TODO: validation, call the API
    console.log('saving', this.email);
  }
}
`,
});
add('customer-app/api', {
  'pom.xml': `
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.2</version></parent>
  <groupId>com.example</groupId><artifactId>customer-api</artifactId><version>0.1.0</version>
  <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>
</project>
`,
  'src/main/java/com/example/customer/ProfileController.java': `
package com.example.customer;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/profile")
public class ProfileController {
    @PutMapping("/{id}/email")
    public String updateEmail(@PathVariable long id, @RequestBody String email) {
        // TODO: validate email, check the caller owns this profile
        return email;
    }
}
`,
});

/* ---- Internal Tools: a single Node monorepo ---- */
add('internal-tools', {
  'package.json': `{
  "name": "internal-tools", "private": true, "workspaces": ["packages/*"],
  "scripts": { "test": "node --test packages" }
}
`,
  'packages/refund-cli/index.js': `
#!/usr/bin/env node
// Issues a refund. Used by support.
const [orderId, amount] = process.argv.slice(2);
console.log(\`Refunding \${amount} on \${orderId}\`);
`,
  'Dockerfile': `
FROM node:latest
COPY . .
RUN npm install
CMD ["node", "packages/refund-cli/index.js"]
`,
  '.env': 'STRIPE_KEY=sk_test_not_a_real_key\n',
});

console.log(made.length ? `Created ${made.length} demo repo(s) in ${WS}:\n  ${made.join('\n  ')}` : `Demo workspace already exists at ${WS} (use --reset to rebuild it).`);
