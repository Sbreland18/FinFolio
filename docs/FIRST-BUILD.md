# First build, step by step

Start to finish: from the unzipped folder to an installer you can double-click,
plus automatic updates for every copy you have installed.

---

## Part 1 — Build the installer (15 minutes, mostly waiting)

### 1. Install Node.js

Go to <https://nodejs.org> and download the **LTS** version. Run the installer
and accept every default. Nothing else is needed — no Visual Studio, no Python,
no build tools.

> Already have Node? Check the version with `node -v` in a terminal. It must be
> 20 or newer.

### 2. Put the project somewhere sensible

Unzip it to a folder you will not accidentally delete, such as
`C:\Users\<you>\Projects\finfolio`.

Avoid building from a folder that OneDrive is syncing — OneDrive occasionally
locks files mid-build. If your Documents folder is synced, use `C:\Dev\finfolio`
instead.

### 3. Run the build

Double-click **`Build FinFolio (GUI).bat`**.

A window opens and tells you whether Node.js was found. Press
**Build the installer**. Output appears in the black panel as each step runs —
installing dependencies, checking the source, running the tests, then building.
The first run downloads Electron (about 150 MB), so it takes a few minutes;
later builds take under a minute.

When it finishes, press **Open output folder**.

> The very first step is the slowest and the quietest — npm prints almost
> nothing while it downloads. As long as the bar at the top is still moving,
> it is working. Press **Stop** if you ever need to abandon a build.

> Prefer a console window? `build.bat` does exactly the same thing.

### 4. Install it

In the `dist` folder you will find two files:

| File | What it is |
|---|---|
| `FinFolio-Setup-1.0.0.exe` | The installer. Run it, or copy it to another PC. |
| `FinFolio-Portable-1.0.0.exe` | Runs with no installation — good for a USB stick. |

Windows will show a blue **"Windows protected your PC"** box the first time,
because the file is not code-signed. Click **More info → Run anyway**. This is
expected for any self-built application; the [README](../README.md#about-the-smartscreen-warning)
explains how to remove it permanently.

### 5. First launch

FinFolio asks a few setup questions: theme, currency, your accounts, and
whether you want a password. Enter the balance your bank shows **today** for
each account — FinFolio works forward from there.

When you add a credit card or loan, leave **“Add this payment to Bills & Income”**
ticked and give it the due day from your statement. The payment then appears
with your other bills, on the calendar and in the forecast, and the amount
tracks the balance so the minimum is always current. Already added your cards?
**Debt Payoff → Add payments to bills** does them all at once.

Two things you will want the first time a month goes sideways — both live in
the **⋯** menu on any row in Bills & Income:

- **Skip just this date** — for the holiday skip-a-pay your bank offers, or a
  month you paid ahead. It removes that one occurrence; next month is still
  due as normal. On a loan it offers to add the interest that still accrues
  and any fee, so the payoff date stays honest.
- **Set the amount for just this date** — for a payday that varies or a bill
  that came in high. The figure sticks to that occurrence only.

Both show up as an **Adjusted dates** list inside the schedule, and both can
be undone from there or from the row itself.

Not ready to enter real data? The empty dashboard has an
**"Or explore with sample data first"** link that fills the app with a fictional
household so you can click around. Settings → Data & storage → *Erase all data*
clears it when you are done.

---

## Part 2 — Set up automatic updates (10 minutes, once)

This is what lets you fix something on your laptop and have every installed copy
update itself.

### 1. Create the repository

On GitHub, create a new **public** repository named exactly **`finfolio`** under
your account `Sbreland18`. Do not add a README or .gitignore — the project
already has them.

> Using a different name or account? Change `owner` and `repo` in
> `electron-builder.yml`, and the two GitHub links in `src/main/menu.js`.

### 2. Push the project

Open a terminal in the project folder (Shift + right-click → *Open PowerShell
window here*) and run:

```bash
git init
git add .
git commit -m "FinFolio 1.0.0"
git branch -M main
git remote add origin https://github.com/Sbreland18/finfolio.git
git push -u origin main
```

If Git is not installed, get it from <https://git-scm.com>.

### 3. Publish the first release

```bash
git tag v1.0.0
git push --tags
```

GitHub Actions builds the installer on a Windows machine and attaches it to a
release automatically. Watch it on the **Actions** tab of your repository; it
takes about five minutes. When it is done, the **Releases** page has the
installer and a `latest.yml` file — that second file is the update feed.

### 4. Every release after that

Make your changes, then:

```bash
npm version patch          # 1.0.0 -> 1.0.1
git push --follow-tags
```

That is the whole process. Use `npm version minor` for new features and
`npm version major` for big changes. Anyone running FinFolio is offered the
update within a few hours, or immediately via **Settings → Updates → Check now**.

> **The version number is the only thing that matters.** An installed copy
> updates when the published version is *higher* than its own. Publishing the
> same version twice does nothing.

### Publishing from the build window instead

If you would rather not use Git tags:

1. On GitHub: **Settings → Developer settings → Personal access tokens →
   Tokens (classic) → Generate new token**, tick **repo**, and copy the token.
2. In the build window, tick **Publish to GitHub Releases**, paste the token,
   bump the version with the **Patch +** button, and press **Build the installer**.

---

## Part 3 — Using FinFolio on more than one computer

Do Part 1 on each computer (or just copy the installer across — you only need to
build once).

### On the computer that already has your data

1. **Settings → Sync across computers.**
2. If FinFolio found OneDrive, Dropbox or Google Drive it offers a button like
   **Use OneDrive** — press it. Otherwise press **Choose a folder…** and pick a
   folder inside whichever one you use.
3. Confirm. Your data moves there. The old copy stays behind, renamed
   `data.moved-…json`, so nothing is lost.

Wait for the cloud client to finish syncing (its tray icon stops spinning)
before moving to the next computer.

### On each other computer

1. Install and open FinFolio. Skip through the setup — you can leave it empty.
2. **Settings → Sync across computers → Choose a folder…** and pick **the same
   folder**.
3. It will notice there is already FinFolio data there and ask. Choose
   **“Use the data there.”**

That computer now shares the same books.

### Day to day

Use whichever computer you like. If one has changed the file since the other
opened it, FinFolio says so and offers **Merge both**, **Keep mine**, or **Use
the other version**. Merge is almost always the right answer — it keeps both
sides' entries, takes the newer version of anything edited twice, and respects
anything you deleted.

Closing FinFolio when you finish on a machine keeps things simplest, but nothing
breaks if you forget.

> **If you use a password**, set the same one on every computer — the file
> itself is encrypted with it, so a different password cannot open it.

### Without a cloud folder

Export a backup on one computer (**Settings → Backup → Export a backup file**),
carry it over on a USB stick, and on the other computer choose
**Restore from a file → Merge**. Same result, done by hand.

---

## Part 4 — Keeping your data safe

Your data lives in `%APPDATA%\FinFolio\data.json` — or in the shared folder if
you set one up in Part 3. Use **Settings → Data & storage → Show data file** to
open its folder.

**What is automatic**

- A backup the first time you open FinFolio each day.
- A backup when you close it.
- The most recent 20 are kept, in `%APPDATA%\FinFolio\backups`.

**What to set up once**

**Settings → Backup & restore → Keep a copy in the cloud.** FinFolio lists the
cloud folders it can actually find on this PC — Google Drive (including the
`G:\My Drive` virtual drive), OneDrive for work or school, Dropbox — and press
one. From then on every automatic backup is copied there too and your cloud app
uploads it. Existing backups are copied over straight away.

If the cloud folder is ever offline, the local backup still happens and you get
a note that the copy did not; nothing is lost.

**What you can also do by hand**

**Settings → Backup → Export a backup file** saves a single `.finbak`
containing everything — handy for a USB stick before a big change.

**Restoring after a reinstall or a new PC**

Install FinFolio, open it, skip through the setup, then
**Settings → Backup → Restore from a file** and choose your `.finbak`.
Everything comes back — accounts, transactions, bills, budgets, goals, settings.

**If you set a password**

There is no recovery, by design: the password is never stored, only used to
derive the key. Write it down somewhere safe. Keep at least one backup you can
still open.

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| "Node.js was not found" after installing it | Close the build window and reopen it — it cannot see programs installed after it started. |
| Build fails with "EBUSY" or "file in use" | Close any running copy of FinFolio, then build again. |
| The app runs but no window shows | End every `FinFolio` task in Task Manager, then launch again. The startup log is at `%APPDATA%\FinFolio\logs\main.log`. |
| Build fails with `Unexpected token '﻿', "﻿{ "name"...` | An invisible character got into `package.json`. Building again fixes it — the check step strips it automatically. |
| Build fails oddly after an update | Delete the `node_modules` folder and build again. |
| Update never arrives | The published version must be higher than the installed one, and the release must not be a draft. Settings → Updates → *Check now* shows the real error. |
| A screen looks broken after you edit something | Run `npm run verify` — it names the file and line. |
| Two computers keep asking to merge | Both have unsaved changes each time. Harmless — merging keeps everything — but closing FinFolio when you finish on a machine stops it. |
| One computer cannot open the shared file | It is encrypted with a different password, or the cloud client has not finished syncing. |
| A cloud folder button says it cannot be used | The message names the reason. Usually the cloud app is still signing in or setting up — let it finish, reopen the screen, and try again. |
| You need to miss one payment | ⋯ on the row → *Skip just <date>*. Do not delete the schedule — that removes every future payment too. |
| A payday is a different amount this time | ⋯ on the row → *Set the amount for just <date>*. Editing the schedule itself would change every future payday. |
| A category has the wrong icon | Settings → Categories & rules → *Manage categories*, click the category, pick from the icon grid. |

Nothing here talks to a server, so there is no account to lose access to and no
subscription to lapse. The worst case is always recoverable from a backup file.
