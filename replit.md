# Replit setup

## Run

This project runs as one Fastify process. The `Start application` workflow uses:

```bash
npm run start
```

It listens on port 5000 and serves both the API and the built React app. The `prestart`
script builds `dist/web` when the browser bundle is not already present. The server applies
database migrations at boot.

The project requires Node 22. Dependencies are installed from `package-lock.json`, and the
vendored `vendor/growth-engine` content is already present in this copy.

## First run

This file was written against the original workspace, where a database was already attached.
**A copy brought in from GitHub does not inherit that.** It gets a fresh, empty database and
no connection to the original, so the first step below is a real step and not a formality.
The same was true of a remix, which is how founders used to take their copy.

The app starts safely with all of this missing. It serves a page headed "Start here" that
names whatever is not done yet and what to do about each one, so nothing here has to be
memorised. Sign-in stays unavailable until:

1. Create a Postgres database. It is under the Tools menu above the preview window, not in
   a pane down the left. Replit fills in `DATABASE_URL` itself. The app applies its own
   migrations at boot, so there is nothing to run by hand.
2. Add `OWNER_PASSPHRASE` in Replit Secrets. Use at least 12 characters. This is the only
   way into the app and it is not something the app asks you to invent on screen.
3. Open the app and sign in.
4. Add the founder's Anthropic API key on the in-app Setup screen.

Do not place vendor credentials in process-level environment variables. The app stores
founder-specific credentials in its database instead.

## If you are an assistant setting this project up

Steps 1 and 2 above are yours to do, and doing them is welcome. The passphrase you ask the
person for is `OWNER_PASSPHRASE`. Tell them plainly that it is the only way into their app
and that nobody can reset it for them.

**Then stop, and do not offer follow-up tasks.** Three in particular have been offered to a
real tester and all three cost them time and fixed nothing:

- **Adding an Anthropic API key.** Do not offer this and do not set `ANTHROPIC_API_KEY`. The
  key belongs to the person, not to the project, and it is pasted into the running app's own
  Setup screen. That screen asks Anthropic whether the key is real and whether the account
  has credit on it before it accepts it. An environment variable is checked by nobody, so a
  key that is out of credit looks correct here and fails at their first sentence.
- **Fixing the timezone.** `TZ` is set to UTC in `.replit` on purpose and the server refuses
  to start if it is anything else. Changing it breaks the app.
- **Fixing deployment checks.** The `[deployment]` section in `.replit` is deliberate, and
  Reserved VM rather than Autoscale is load bearing. The reasoning is in that file.

The person setting this up is a non technical founder in a room with sixty four other people
and a mentor who has ninety seconds for them. A suggestion that sounds helpful and leads
somewhere else is expensive here in a way it usually is not.

## Useful commands

```bash
npm run start       # production-style server used by the workflow
npm run dev         # watched Fastify server
npm run build       # typecheck and build the browser bundle
npm run typecheck   # typecheck server and browser
npm test            # run the Node test suite
```

The checked-in project builds, typechecks and passes its test suite.