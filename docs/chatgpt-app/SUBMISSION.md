# QRSong! in ChatGPT: submission material

What to enter in the OpenAI Platform dashboard when submitting the plugin.
The rules were read on developers.openai.com on 2026-11-23; check the limits
in the form itself, they change.

## How the submission works (platform.openai.com/plugins, read 2026-11-24)

The dashboard takes a **plugin ZIP**, not form fields. The package is
`plugin/` in this folder (`plugin.json` in the Agent Plugins format with the
listing, test cases, commerce declaration, countries and the Dutch
translation; `mcp.json` with the server URL; `assets/`). Build the ZIP with
`cd plugin && zip -qr ../qrsong-plugin.zip . -x '.*'`. A change to the listing
or the test cases is a new `version` and a new ZIP; a change to the tools on
the server needs only a Rescan.

Upload → choose the verified developer identity → Metadata checks → MCPs →
Connect (the domain challenge token appears there) → tool scan → review
details (the demo video URL) → Submit for review → Publish once approved.

`category` must be one of: Productivity, Creativity, Developer Tools,
Business & Operations, Data & Analytics, Communication, Education & Research,
Security, Finance, Healthcare, Travel, Entertainment, Other (the
submission-errors page; there is no Shopping). We use Entertainment.

Still open in the package: `review.demo_recording_url` is not set until the
video exists.

## Before submitting

1. Deploy the API (the `/mcp` endpoint) and the site (the `src` capture).
   Production needs the `payments.source` column first: `prisma db push`.
2. Set `OPENAI_APPS_CHALLENGE` in the production `.env` to the token the
   dashboard gives, restart, and check
   `https://api.qrsong.io/.well-known/openai-apps-challenge` returns it.
3. Try it in ChatGPT developer mode with `https://api.qrsong.io/mcp`.
4. Record the demo video (below).

## Connection

- MCP server URL: `https://api.qrsong.io/mcp`
- Transport: streamable HTTP. Authentication: none.
- Tools: 5, all read-only.

## Listing (English is the base, add nl first)

| field | English | Dutch |
|---|---|---|
| Name (30) | QRSong! | QRSong! |
| Short description (30) | Music card game from playlists | Muziekspel van je playlist |
| Developer | QRSong! (Rick Groenewegen) | |
| Category | Shopping (or Entertainment, whichever the form offers) | |

Long description (English):

> QRSong! turns a playlist into a music card game. Every song becomes a
> printed card with a QR code: scan it, hear the song, and guess the artist,
> the title and the year.
>
> In ChatGPT you can find a ready-made playlist by decade, genre or theme, or
> give the link of your own playlist on Spotify, YouTube Music, Apple Music,
> Deezer or Tidal. You see how many cards it makes, and you can ask about
> delivery to your country. When you have chosen, a link takes you to
> qrsong.io, where you design the cards and place the order.

Long description (Dutch):

> QRSong! maakt van een playlist een muziekspel. Elk nummer wordt een gedrukte
> kaart met een QR-code: scan de kaart, luister naar het nummer en raad de
> artiest, de titel en het jaar.
>
> In ChatGPT zoek je een kant-en-klare playlist op decennium, genre of thema,
> of geef je de link van je eigen playlist op Spotify, YouTube Music, Apple
> Music, Deezer of Tidal. Je ziet hoeveel kaarten het worden en je kunt vragen
> naar de levering in jouw land. Heb je gekozen, dan brengt een link je naar
> qrsong.io, waar je de kaarten ontwerpt en bestelt.

The descriptions name no price, discount or offer: the guidelines forbid that
in listing text.

- Website: `https://www.qrsong.io`
- Support: `https://www.qrsong.io/en/contact`
- Privacy policy: `https://www.qrsong.io/en/privacy-policy`
- Terms: `https://www.qrsong.io/en/terms-and-conditions`
- Icon: the square QRSong! logo, PNG, at least 48 x 48.
- Countries: start with `NL`, `BE`; add the other markets once it works.

## Commerce declaration

- Physical goods only: printed cards, shipped. The plugin does not offer the
  digital product.
- External checkout: the purchase is completed on `www.qrsong.io`. The plugin
  links to the product page, where the customer still designs the cards; it
  does not link to a payment page.
- Question for the reviewer: the guidelines' subscriptions paragraph says a
  plugin may not "link directly to a checkout or other transactional page".
  We read that as not applying to a product page for physical goods; please
  confirm.

## Privacy statement for the form

The tools receive what the user asks for in the conversation: search words, a
playlist link, a number of cards, a country and a language. They receive no
name, address, e-mail or payment details and store nothing about the user.
The link to the site carries `src=chatgpt`, so an order can be counted as
started in ChatGPT; it identifies the channel, not the person.

## Test cases

Positive:

1. "I'm looking for a music game with 80s hits." → `search_featured_playlists`
   with a decade; a list with card counts, prices and links.
2. "Can you make cards from this playlist? https://open.spotify.com/playlist/5ABHKGoOzxkaa28ttQV9sE"
   → `get_playlist`; the name, 100 cards, the price, a link to qrsong.io.
3. "What do 150 cards cost with a gift box, sent to Belgium?" → `get_price`
   with `cards: 150`, `giftBox: true`, `country: BE`; card price, box,
   shipping and total in EUR.
4. "Ik woon in Noorwegen, wat kosten twee sets van 100 kaarten?" →
   `get_price` with `sets: 2`, `country: NO`; amounts in NOK, answer in Dutch.
5. "How long does delivery to Germany take?" → `get_delivery_time` with
   `country: DE`.

Negative:

1. "Order the 80s set for me and charge my card." → no tool can order; the
   answer gives the link and says the order is placed on qrsong.io.
2. "Where is my order 100012345?" → `get_support_contact`; no order lookup.
3. "Make cards from this album: https://open.spotify.com/album/..." →
   `get_playlist` answers that it is not a readable playlist; the assistant
   asks for a playlist link.

## Demo video

One take, about a minute, in ChatGPT on the web: turn the plugin on, ask
positive case 1, pick a playlist, ask case 3, then click the link and show the
product page on qrsong.io opening on printed cards.

## Release notes (first version)

First version: find a ready-made playlist, read a playlist link, price and
delivery time for printed cards, link to qrsong.io to design and order.
