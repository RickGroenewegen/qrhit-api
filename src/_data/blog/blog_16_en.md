I keep seeing the same question in my search logs, and it is not from people looking for a party game. It is musicians: how do you put a QR code on a poster, a business card, a merch table sign or the back of a vinyl sleeve so that someone can point their phone at it and hear your music.

I build QR music cards for a living, so I have spent an unreasonable amount of time on the details of this. Here is what actually works, including the parts that trip people up.

## The basic version takes two minutes

1. Open your track, album or artist page in Spotify, Apple Music, Bandcamp or wherever it lives, and copy the share link.
2. Paste that link into any free QR code generator.
3. Choose a **static** code, not a dynamic one.
4. Download it as SVG if you are putting it into a design, or PNG at 300 dpi if you are not.

That is a working QR code. The rest of this post is the things that make the difference between one that gets scanned and one that does not.

## Static or dynamic, and why it matters more for musicians

A static code holds the link inside the pattern. It is free, it never expires, and it cannot be switched off by a company going out of business. A dynamic code holds a redirect URL that points at somebody's server, which then forwards to your link. That gives you editable destinations and scan analytics, and it stops working the day that service shuts down or your trial ends.

For a poster that goes up for three weeks, dynamic is fine and the analytics are genuinely useful. For anything printed permanently, and especially for anything that goes on merch or a record sleeve, use static. A dead QR code on a physical object you sold to someone is a bad look for years.

If you want editability without the dependency, point a static code at a URL you control, a page on your own site, and change what that page does. The code never changes, the destination is yours.

## Point it somewhere that works for everyone

This is the mistake I see most. A Spotify link is useless to someone on Apple Music, and a Bandcamp link means nothing to a passer-by who just wants to hear the song.

Options, roughly in order of how well they work:

- **Your own landing page.** Best, if you have one. You control it, it works for everyone, and you can change what is on it without reprinting anything.
- **A smart link.** The various "one link, all services" tools solve exactly this and are free at the low end. Same caveat as dynamic codes: it is someone else's server in the middle.
- **A single service link.** Fine when you know your audience is there, which at a venue merch table is often true. Not fine on a poster in the street.

Whatever you choose, scan it yourself, on somebody else's phone, before you print a hundred of them.

## Printing it so it actually scans

- **Size.** About 2 cm square is the practical minimum. 2.5 to 3 cm is forgiving. On a poster people will scan from two metres away, go much bigger: roughly a tenth of the viewing distance is a decent rule.
- **Quiet zone.** Leave clear space all the way around, about four modules' worth. Designers hate this and it is the single most common reason a code fails.
- **Contrast.** Dark code on a light background. Light-on-dark works on some scanners and fails on others, and you will not find out which until someone tells you.
- **Do not stretch it.** Scale it proportionally. A squashed code is a broken code.
- **Avoid the fold.** On a gatefold or a folded flyer, keep it away from the crease.
- **Test the actual print**, not the screen. Ink bleed on uncoated stock closes up the gaps in a way a PDF preview will never show you.

## Where a QR code earns its place

Merch tables, because someone who just watched you play will scan before they have decided to buy. Posters and flyers, where the alternative is hoping they remember your name. The back of a business card. Inside a vinyl or CD sleeve, linking to the digital version or to something extra. Stage banners, if they are big enough to scan from the crowd.

Where it does not earn its place: anywhere someone cannot physically stop and point a phone at it, and anywhere with no mobile signal.

## If you want the cards rather than the code

This is the part where I mention what I actually make, so you know where the advice is coming from.

[QRSong!](/[lang]/pricing) turns a whole playlist into a deck of printed cards, one song per card, with a QR code on the front and the artist, title and release year on the back. Bands use them as merch and as a giveaway: a deck of your own catalogue, or a deck of the songs that influenced the record.

If you just want the free method for one song, I wrote that up separately: [how to make a QR code for a song](/[lang]/qr-code-for-a-song), step by step per streaming service.

## FAQ

### What is the best QR code for a musician to use?

A static code pointing at a landing page you control. Static means it never expires and does not depend on another company staying in business; a page you own means you can change where it sends people without reprinting anything.

### Are QR code generators free?

Static codes are free and unlimited from most generators, with no account. You pay when you want dynamic codes, editable destinations or scan tracking.

### How big should a QR code be on a poster?

Roughly a tenth of the distance people will scan from. A poster read at two metres wants a code around 20 cm. At arm's length on a flyer, 2 to 3 cm is plenty.

### Can a QR code link to Spotify and Apple Music at the same time?

Not directly, a code holds one URL. Point it at a landing page or a smart link that offers both, and it works for everyone regardless of what they use.

### Will my QR code stop working?

A static code will not: the link is inside the pattern. What breaks is the destination. If the page moves or the service closes, the code still scans and lands nowhere, which is why pointing it at a domain you control is worth the effort.

### Should I put a QR code on vinyl or CD packaging?

Yes, and use a static code for it. Packaging outlives most link-shortening services, and a dead code inside a record someone bought is not something you can fix later.
