# SpeedBike — Go-Public Plan

Order matters: fix what ruins a first impression, test small, then go wide. Players who bounce on a bad first try rarely return.

## Phase 0 — Foundations (before anyone outside sees it)
| Item | What | Status |
|---|---|---|
| Domain | **Decided: `playspeedbike.com` at Cloudflare Registrar** (~$10–11/yr, at cost, same price every year). Avoid promo TLDs: `.online` $0.98 → ~$29–40/yr renewal; `.io` ~$15 first year → ~$40–55/yr. Always check the **renewal** price at checkout. | ☐ |
| Domain hookup | Cloudflare DNS: 4 A records to GitHub Pages (185.199.108–111.153) + `www` CNAME to `<user>.github.io`, proxy **off** (grey cloud) so GitHub can issue the certificate. Repo Settings → Pages → custom domain, then "Enforce HTTPS". Also add the domain to the server's allowed origins and Firebase auth authorized domains. | ☐ |
| Server | No sleeping free tier: move Render to a paid plan. Load test with 20–30 concurrent players. | ☐ |
| Solo queue + bots | `tasks/task-solo-queue-bots.md` — no empty lobbies ever. | ☐ |
| Analytics | Track: first match started, first match finished, day-1 / day-7 return, where people quit. Privacy-friendly tool or Firebase events. | ☐ |
| Legal | Privacy policy + terms of use pages (accounts + email = required; portals ask for them). | ☐ |
| Branding | Never use "LightBike" in titles, tags or ads. | ☐ |
| Feedback home | Discord server, linked from the main menu. | ☐ |

## Phase 1 — Closed beta (1–2 weeks, 20–50 people)
- Friends, classmates, small Discords. Watch analytics, fix confusion.
- Goal: a new player finishes their first match without any explanation.
- Exit when: first-match completion is high and day-1 return is ~30%+.

## Phase 2 — Soft launch (free, low risk)
- itch.io page: GIF, short description, browser build link.
- Reddit, one honest post each with a clip: r/WebGames, r/IndieGaming, r/playmygame.
- #ScreenshotSaturday on X / Bluesky every week.

## Phase 3 — Web game portals
- CrazyGames, Poki: millions of browser players. They usually require their SDK and their ads (check against the monetization task). Poki is selective.

## Phase 4 — Content push
- Needs: near-miss popups, clip export (players make the ads).
- Daily 15–30 s vertical clips on TikTok / Shorts / Reels. One moment per clip. Hook: "free, no download, plays in your browser".

## Phase 5 — Later
- Phone app wrapper (Capacitor) for Play Store / App Store, only once web retention is good.

---

## Building an audience now: getting people to recommend the game
Word of mouth only happens when sharing is **one tap** and **rewards both people**. Priority order:

1. **Invite link that drops a friend straight into your party.** `playspeedbike.com/?party=CODE` → opens the game, joins the party, no menus. Today the party system has no link, so this is the single biggest missing piece. Reward both sides on the friend's first finished match (coins + an "invited" glow color only obtainable this way).
2. **Founder badge.** Every account made before public launch gets a permanent "Founder" badge next to the name. It gives a reason to join *now* and to bring friends before the cutoff. Costs nothing.
3. **Share card after a match.** One button: an image of the final trail art + "I won 5–2 in Hyper" + the link. Uses the native share sheet on phones.
4. **Challenge link.** "Beat my run on this seed": opens the game against your ghost. People forward challenges more readily than ads.
5. **Discord with a reason to be there:** weekly event (featured mode already rotates), patch notes, sneak peeks, a #clips channel, players' suggestions that you actually ship and credit.
6. **Small creators.** Message small YouTubers / TikTokers who play browser games (1k–50k followers answer; big ones don't). Offer a unique creator glow color for them and their viewers' code.
7. **Ask in person.** School, friends, local LAN / gaming clubs: 10 people playing together in one room is the best test and the best first word of mouth.

What not to do: fake reviews, fake player counts, buying followers. One exposure kills a small indie.
