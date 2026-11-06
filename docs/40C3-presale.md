# 40C3 presale – what I found (checked 2026-11-06)

Sources:
- The live shop at <https://tickets.events.ccc.de/40c3/>, fetched 2026-11-06.
- The official page <https://events.ccc.de/congress/2026/infos/tickets/>.

## Dates (official, all CET)

| Round | When | MTRT preset |
|---|---|---|
| Community sale (voucher only) | 2026-10-23 10:00 CEST → 2026-11-10 23:00 CET | – |
| **Public sale 1** | **Sun 2026-11-08 11:00 CET** | `round-1` |
| Public sale 2 | Wed 2026-11-11 18:00 CET | `round-2` |
| Public sale 3 | Thu 2026-11-19 20:00 CET | `round-3` |

The shop itself says: *"Tickets will be sold on 2026-11-08 11:00 (CET)."*

If tickets are left after the public dates, the shop reopens later until sold out or just before Christmas.

## How it works

- **Platform:** pretix ("CCCV GmbH based on pretix"), behind an **openresty** front end (`server: openresty`).
- **Opening is automatic** at the announced time. Quote: *"You will want to (re-)load the ticket shop page at that time. Quality beats quantity: reloading at the correct time matters, whereas the only result of hammering the ticket shop with reloads is a sad and dying ticket shop server."*
- **There is a queue.** Quote: *"Once the public presale has started, you will be placed in a queue … expected to move slowly … In the past … thirty to sixty minutes."* An estimated waiting time is shown. At the end of the queue you are redirected to the shop. Reaching the shop does not guarantee a ticket.
- **Queue cookie:** the front end sets `__QXSESSION` (30 days, `Path=/`) on the very first request. The queue position is almost certainly tied to this cookie. So:
  - keep one browser profile;
  - never clear cookies on sale day;
  - never reload a queue page.
- **Intro page:** `/40c3/` redirects once to `/40c3/intro/` and sets `intro_seen_40c3`. After that, `/40c3/` shows the shop directly. MTRT treats the intro page as "closed".
- **Before opening** the page says *"Tickets will be sold on …"*. Every product shows *"Enter a voucher code below to buy this product."* (class `availability-box unavailable`), and there are no quantity inputs. The official page warns that right before the start a different "presale will start soon" page may be shown instead. MTRT handles both.
- **When open** (standard pretix), each product gets a quantity input `item_…` / `variation_…` and an **"Add to cart"** button. That is MTRT's default "open" detector. Since the queue comes first, you will most likely land on the **queue page** first, and MTRT stops there.
- **CAPTCHA:** not mentioned for 40C3. The 37C3 and 38C3 pages said a captcha had to be solved to enter the queue. If one appears, MTRT stops and alerts, and you solve it yourself.
- **No account or login needed.** No voucher is needed in the public sale. Vouchers were only for the community phase.
- **Cart limits:** up to **2 tickets per cart**, plus up to 3 Up-and-Coming (U18) tickets. The cart holds for **10 minutes**: you must *complete the order* in that time, but you don't have to pay yet.
- **Payment:** bank transfer (German account, Postbank, BIC `PBNKDEFF`) or credit card via Stripe. You can switch method later. **The deadline is 7 days.** A weekend instant transfer may only be booked on Monday.
- **Prices:**

  | Ticket | Price |
  |---|---|
  | Standard | 200 € |
  | Supporter | from 230 € |
  | Business | from 575 € (invoice right away) |
  | Member | 185 € |
  | U18 | 60 € |

  Children under 12 get in free. Friends tickets (reduced price) are requested via a form in the shop, and you have 10 minutes to write the text. You can prepare it in advance.
- **Automation:** I found no explicit ban. The organisers ask for punctual, not frequent, reloads. MTRT's defaults stay light: one request every 500 ms across all tabs for ~33 s around T, then one every 2.5 s. It never touches forms, captchas or the queue.

## What you need to prepare before Sunday

1. **Decide your ticket type and quantity** (max 2 + U18), and who they're for.
2. **Have your details ready:** name, e-mail, invoice address (Business ticket). Use a password manager or autofill for speed. The 10-minute cart timer starts in the shop, not in the queue.
3. **Payment:** a credit card is quickest. Otherwise a bank transfer within 7 days.
4. **Friends ticket?** Write the text in advance.
5. **Run MTRT once against the real shop on Saturday.** Use "Open browser & load tabs once". This sets `__QXSESSION` and `intro_seen_40c3` in MTRT's own profile (`.profile/`), and you can check the page is classified as `closed`.
6. **Set up ntfy and test it** (see README).
7. **Use wired Ethernet** if you can. Plug the Mac in. Turn off VPN / iCloud Private Relay for this browser: an exit node changing mid-queue could invalidate the session.
8. **Practise once in test mode** (`npm run test-mode`). The run takes 90 s.
