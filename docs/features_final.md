# QRSong! Platform Documentatie

## Kernfunctionaliteit
- Genereer in enkele simpele stappen van je Spotify playlist fysieke of digitale kaarten
- Kaarten zijn volledig in eigen design te ontwerpen
- QR codes verwijzen naar een link van QRSong en niet direct naar Spotify om werking te blijven garanderen
- Eigen mobiele app voor Android en iOS

## Infrastructuur & Schaalbaarheid
- Volledig schaalbaar opgezet in AWS met: EC2 / ALB / Autoscaling
- Alle pagina's gecached via Redis → Nauwelijks DB load
- Zware taken gebeuren via AWS Lambda tasks of externe diensten (QR generatie / PDF generatie) waardoor servers nauwelijks werk hebben
- Centrale file storage via EFS 
- CloudFront: QR link caching / beveiliging tegen bots
- Automatische backups in AWS van EC2, RDS en EFS

## Database & Databeheer
- Database met MySQL (via Prisma)
- Caching met Redis
- Eigen database met 140k+ geverifeerde release data (>80% van de aangeboden nummers worden op die manier direct goed gezet)
- Van iedere track houden we ook de Apple Music, Deezer, Tidal, YouTube Music en Amazon Music links bij voor toekomstige uitgebreidingen naar andere muziek platformen

## Meertalige Ondersteuning
- Backend, frontend en app in 11 talen uitgerust
- Vertalingen gebeuren volledig automatisch via OpenAI API's
- Op taal gebaseerde content (Speciale playlists)

## Spotify Integratie & Muziekdata
- Volledige integratie met Spotify: Playlists en tracks worden uitgelezen
- Overgebleven tracks worden automatisch door een geavanceerd AI systeem op het goede jaar gezet
- AI systeem gebruikt diverse bronnen en neemt autonoom beslissing over jaartal
- Als AI er niet uit komt komen de nummers op een automatische lijst die handmatig beoordeeld worden
- Admin track management: Iedere track is door de admin te bewerken om correcties door te voeren
- Kapotte links zijn te repareren via track management. Kaartjes blijven altijd werken zolang er een versie van het nummer beschikbaar is
- Systeem om duplicate nummers te detecteren en gebruikers hier op te wijzen

## Jaartal Verificatiesysteem
- Jaartal beoordelingssysteem: Admin ziet razendsnel de informatie, jaartallen en kan een beslissing nemen
- Na jaartalverificatie ontvangt de gebruiker zelf een verzoek de playlist te beoordelen
- Gebruiker kan in het beoordelingssysteem het jaartal nog aanpassen, nummers verwisselen, informatie corrigeren en informatie toevoegen
- Na goedkeuring komen eventuele correcties weer terug bij ons. Wij keuren ze goed en de correcties worden in onze DB opgenomen voor alle toekomstige gebruikers

## Ontwerpsysteem
- Design systeem om kaart volledig in eigen stijl te ontwerpen (Eigen afbeeldingen, kleuren en lettertypes)
- Mogelijkheid om persoonlijke boodschappen / extra informatie op de kaarten kwijt te kunnen
- Ontwerp wordt eerst door ons gecontroleerd voordat het naar de drukker kan
- Eco vriendelijke print optie
- Digitaal: Dubbelzijdig of enkelzijdig printen
- Voorbeeld PDF's aanwezig om te testen

## E-commerce & Betaling
- Winkelmand om meerdere playlists in een keer te bestellen
- Volledige Mollie integratie met webhooks voor alle betaalmethodes
- Betaalmethodes worden per land specifiek aangeboden
- Bestelling kan privé of zakelijk gedaan worden met afwijkend factuuradres
- Automatische factuur generatie en verzending via PDF
- Wereldwijde verzending naar (bijna) alle landen
- Correcte BTW berekening (ook internationaal)
- Houdt automatisch rekening met verzendkosten wereldwijd

## Korting & Cadeaubon Systeem
- Kortingscode systeem: Algemene codes of persoonlijke code
- Admin dashboard om kortingscodes te beheren en uit te geven
- Volume discount systeem voor digitale lijsten
- Gift card systeem: Gift cards te bestellen die automatisch kortingscodes aanmaken. Via PDF in mail

## Orderbeheer
- Volledig ordermanagement systeem met overzicht orders
- Filter systeem voor openstaande orders / historie
- Mogelijkheid tot verwijderen / dupliceren orders
- Mogelijkheid tot opnieuw genereren bestanden orders
- Orders aan te passen via admin panel

## Printen & Fulfillment
- Volledige integratie met API van drukker
- Drukker verzorgt shipment en fulfillment
- Kaarten worden bij de gebruiker thuisbezorgd. Wij zien de kaarten nooit. Dit gaat volledig automatisch
- Genereert PDF's in allerlei vormen: Dubbelzijdig, enkelzijdig of geschikt voor professioneel printwerk
- Gebruiker ontvangt dan de PDF of het bericht dat de bestelling naar de drukker is gegaan met een gratis PDF versie als download

## Verzending & Tracking
- Verstuurt automatisch tracking links en volgt de volledige shipping via TrackingMore
- Dashboards aanwezig om shipping te volgen
- Inzicht in verzendtijden internationaal d.m.v. TrackingMore. Wordt ook in communicatie / verwachtingsmanagement richting klanten gebruikt
- Pagina met verzend en productietijden per land (Live geactualiseerd)

## Gebruikerservaring & Marketing
- Volledig responsive voor alle schermgroottes
- Featured playlist overzicht: Door gebruikers aangeleverde playlists (Volledig filterbaar, sorteerbaar en doorzoekbaar)
- Speciale landingspagina's voor (Meta ads)
- Corporate oplossingen met stemportalen via OnzeVibe
- FAQ systeem
- Contact mogelijk via e-mail (formulier) en chat (Crisp)

## Review Systeem
- Review systeem: Een gebruiker wordt uitgenodigd voor een review nadat deze > 25 nummers heeft afgespeeld via de app. Dit levert vrijwel alleen maar 5 sterren reviews op
- Review koppeling met TrustPilot. Reviews verschijnen automatisch en vertaald op site

## Beveiliging
- Beveiliging met JWT
- Role-based security voor admins/gebruikers/corporate users
- Role-based access control (RBAC)
- Rate limiting by IP
- Request throttling
- CORS configuration
- Input validation
- SQL injection protection
- XSS protection
- CSRF protection
- HTTPS enforcement
- Correct ingebouwde cookie consent
- Overal systemen ingebouwd om rate limits met externe partijen te bewaken

## Admin Tools & Analytics
- Admin dashboard
- Dag, maand en BTW rapportages op te vragen
- Diverse charts met verkoopcijfers in te zien
- Admin visualisatie kaart: Zie waar er wereldwijd gespeeld wordt en wat
- CloudWatch dashboard met metrics
- PostHog integratie om gebruik te kunnen monitoren
- Google analytics volledig door professioneel bureau ingericht

## Communicatie & Marketing Automatisering
- Amazon SES voor mailen
- Broadcasting systeem waarmee push notificaties naar alle mobiele gebruikers gestuurd kunnen worden
- Automatische koppeling met mailing systeem (Email Octopus) voor mailings. Houdt rekening met opt in/out
- Mailing lijsten per land in te stellen
- Automatisch blog systeem om blog content met AI te genereren (SEO doeleinden)
- Socials volledig ingericht met automatische content via RecurPost

## SEO & Online Aanwezigheid
- N.a.v. van professionele SEO scan rapport site volledig SEO proof gemaakt
- Automatische koppeling met Google Merchant center om 1000+ producten automatisch te plaatsen

## Technology Stack

### Frontend
- Angular 19
- Tailwind
- Angular Universal (SSR)

### Backend
- Node.js / TypeScript
- MySQL
- Redis
- BullMQ integratie voor het afhandelen van bestellingen in een queue