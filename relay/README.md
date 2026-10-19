# TunnelX relays

Two drop-in relays that speak the same API as the Render relay
(`/health`, `/test`, `/fetch`). TunnelX can switch between all three in
Settings → Relay server.

| File | Platform | Strength | Limit |
|---|---|---|---|
| `tunnelx-relay-deno.js` | Deno Deploy | Can trust extra root certificates (`EXTRA_CA_PEM`), so it can open sites signed only by the Russian national CA | Free plan: 1M requests, 20 GiB egress, 10 h active CPU per month |
| `tunnelx-relay-cloudflare.js` | Cloudflare Workers | Fast, never sleeps | Cannot add extra root certificates |

Both support SOCKS5, SOCKS4 and HTTP proxies, follow redirects, and accept an
optional `KEY` secret. When `KEY` is set, every call needs `&k=KEY`;
TunnelX adds it from the "Relay key" field.

## Deno Deploy
1. Open the Deno Deploy dashboard and create a new project or playground.
2. Replace the starter code with the whole of `tunnelx-relay-deno.js` and deploy.
3. Optional: in the project settings add environment variables
   - `KEY`: any long random string
   - `EXTRA_CA_PEM`: the PEM text of the Russian Trusted Root CA
     (download it from the official gosuslugi.ru certificate page).
4. Open `https://<your-project>.deno.dev/health`. You should see `"status":"ok"`.

## Cloudflare Workers
1. Dashboard → Workers & Pages → Create → Worker ("Hello World"), name it `tunnelx-relay`, Deploy.
2. Edit code → replace `worker.js` with the whole of `tunnelx-relay-cloudflare.js` → Deploy.
3. Optional: Settings → Variables and Secrets → add secret `KEY`.
4. Open `https://tunnelx-relay.<your-subdomain>.workers.dev/health`. You should see `"status":"ok"`.

## In TunnelX
Settings (or the sidebar on a computer) → Relay server → paste both addresses,
add the key if you set one → **Save and test all relays**. The activity log
shows each relay's response time. Tap Render / Deno / Cloudflare to switch.
