Arama kayıtlarımda aynı soruyu tekrar tekrar görüyorum, üstelik bunu soranlar parti oyunu arayan insanlar değil. Müzisyenler soruyor: Bir postere, kartvizite, merch masası tabelasına veya plak kapağının arkasına nasıl QR kodu koyarsın ki biri telefonunu tutsun ve müziğini dinlesin?

İş olarak QR müzik kartları yapıyorum, bu yüzden bu detaylara makul sayılamayacak kadar zaman harcadım. İnsanların takıldığı kısımlar dahil, gerçekten işe yarayan şeyler burada.

## Temel versiyon iki dakika sürer

1. Parçanı, albümünü veya sanatçı sayfanı Spotify, Apple Music, Bandcamp ya da nerede duruyorsa orada aç ve paylaşım bağlantısını kopyala.
2. Bu bağlantıyı herhangi bir ücretsiz QR kod oluşturucuya yapıştır.
3. Dinamik değil, **statik** bir kod seç.
4. Bir tasarıma yerleştireceksen SVG olarak indir, yerleştirmeyeceksen 300 dpi PNG olarak indir.

Bu, çalışan bir QR kodudur. Bu yazının geri kalanı, taranan bir kod ile kimsenin taramadığı bir kod arasındaki farkı yaratan şeyler.

## Statik mi dinamik mi, müzisyenler için neden daha önemli

Statik bir kod bağlantıyı desenin içinde taşır. Ücretsizdir, süresi dolmaz ve bir şirket kapandı diye devre dışı kalmaz. Dinamik bir kod, birinin sunucusundaki yönlendirme URL'sini taşır, o sunucu da bağlantına gönderir. Bu sana değiştirilebilir hedefler ve tarama analitiği verir, ama hizmet kapandığı veya deneme süren bittiği gün çalışmayı bırakır.

Üç hafta asılı kalacak bir poster için dinamik kod sorun değil, analitik de gerçekten işe yarar. Kalıcı olarak basılan her şeyde, özellikle merch ya da plak kapağına girecek her şeyde statik kullan. Birine sattığın fiziksel bir nesnenin üstündeki ölü QR kodu yıllarca kötü görünür.

Bağımlılık olmadan değiştirilebilirlik istiyorsan statik kodu kontrol ettiğin bir URL'ye, kendi sitendeki bir sayfaya yönlendir ve o sayfanın ne yaptığını değiştir. Kod hiç değişmez, hedef senindir.

## Herkes için çalışan bir yere yönlendir

En çok gördüğüm hata bu. Spotify bağlantısı Apple Music kullanan biri için işe yaramaz, Bandcamp bağlantısı da sadece şarkıyı duymak isteyen yoldan geçen biri için pek bir şey ifade etmez.

Seçenekler, kabaca ne kadar iyi çalıştıklarına göre:

- **Kendi açılış sayfan.** Varsa en iyisi. Sen kontrol edersin, herkes için çalışır ve tekrar baskı yapmadan içeriğini değiştirebilirsin.
- **Akıllı bağlantı.** Çeşitli 'tek link, tüm servisler' araçları tam olarak bunu çözer ve düşük kullanımda ücretsizdir. Dinamik kodlarla aynı uyarı geçerli: arada başkasının sunucusu vardır.
- **Tek servis bağlantısı.** Kitlenin orada olduğunu bildiğinde sorun değil, bir mekandaki merch masasında bu çoğu zaman doğrudur. Sokaktaki bir posterde iyi değildir.

Ne seçersen seç, yüz tane bastırmadan önce kendin tara, sonra başkasının telefonunda da tara.

## Gerçekten taranacak şekilde basmak

- **Boyut.** Yaklaşık 2 cm kare pratik minimumdur. 2,5 ile 3 cm daha affedicidir. İnsanların iki metre uzaktan tarayacağı bir posterde çok daha büyük yap: izleme mesafesinin yaklaşık onda biri iyi bir kuraldır.
- **Boş alan.** Çevresinde her yönde net boşluk bırak, yaklaşık dört modül kadar. Tasarımcılar bundan nefret eder ve bir kodun çalışmamasının en yaygın nedeni budur.
- **Kontrast.** Açık zemin üzerinde koyu kod. Koyu zemin üzerinde açık kod bazı tarayıcılarda çalışır, bazılarında çalışmaz, hangisi olduğunu da biri sana söyleyene kadar öğrenemezsin.
- **Esnetme.** Orantılı ölçekle. Sıkıştırılmış kod bozuk koddur.
- **Kat yerinden uzak tut.** Gatefold kapakta veya katlanmış broşürde, kırışma çizgisinden uzak tut.
- **Ekranı değil, gerçek baskıyı test et.** Kaplamasız kağıtta mürekkep yayılması boşlukları kapatır, bunu PDF önizlemesi asla göstermez.

## QR kodu nerede yerini hak eder

Merch masalarında, çünkü seni az önce canlı izlemiş biri satın almaya karar vermeden önce tarar. Posterlerde ve flyer'larda, çünkü alternatifi adını hatırlamalarını ummaktır. Kartvizitin arkasında. Bir plak veya CD kapağının içinde, dijital versiyona ya da ekstra bir şeye bağlantı olarak. Kalabalıktan taranacak kadar büyükse sahne banner'larında.

Yerini hak etmediği yerler: birinin fiziksel olarak durup telefonunu tutamayacağı her yer ve mobil sinyalin olmadığı her yer.

## Kod yerine kartları istiyorsan

Burası gerçekten ne yaptığımı söylediğim kısım, böylece tavsiyenin nereden geldiğini bilirsin.

[QRSong!](/[lang]/pricing) bütün bir playlist'i basılı kart destesine çevirir, her kartta bir şarkı olur, ön yüzde QR kodu, arka yüzde sanatçı, başlık ve yayın yılı yer alır. Gruplar bunları merch ve hediye olarak kullanıyor: kendi kataloğundan bir deste ya da albümü etkileyen şarkılardan bir deste.

Tek bir şarkı için ücretsiz yöntemi istiyorsan onu ayrıca yazdım: [bir şarkı için QR kodu nasıl yapılır](/[lang]/qr-code-for-a-song), her streaming servisi için adım adım.

## SSS

### Bir müzisyenin kullanacağı en iyi QR kodu hangisi?

Kontrol ettiğin bir açılış sayfasına giden statik kod. Statik olması süresinin dolmayacağı ve başka bir şirketin ayakta kalmasına bağlı olmadığı anlamına gelir. Sayfanın sana ait olması ise tekrar baskı yapmadan insanları nereye gönderdiğini değiştirebilmen demektir.

### QR kod oluşturucular ücretsiz mi?

Statik kodlar çoğu oluşturucuda ücretsiz ve sınırsızdır, hesap da gerekmez. Dinamik kodlar, değiştirilebilir hedefler veya tarama takibi istediğinde ödeme yaparsın.

### Bir posterde QR kodu ne kadar büyük olmalı?

İnsanların tarayacağı mesafenin yaklaşık onda biri. İki metreden okunan bir posterde kodun yaklaşık 20 cm olması iyi olur. Bir flyer'da kol mesafesinde 2 ile 3 cm fazlasıyla yeterlidir.

### Bir QR kodu aynı anda Spotify ve Apple Music'e bağlanabilir mi?

Doğrudan hayır, bir kod tek URL taşır. Her ikisini de sunan bir açılış sayfasına veya akıllı bağlantıya yönlendirirsen, herkes hangi servisi kullanırsa kullansın çalışır.

### QR kodum çalışmayı bırakır mı?

Statik kod bırakmaz: bağlantı desenin içindedir. Bozulan şey hedeftir. Sayfa taşınırsa veya servis kapanırsa kod hâlâ taranır ama hiçbir yere varmaz. Bu yüzden kontrol ettiğin bir alan adına yönlendirmek uğraşmaya değer.

### QR kodunu plak veya CD ambalajına koymalı mıyım?

Evet, ve bunun için statik kod kullan. Ambalaj çoğu bağlantı kısaltma servisinden daha uzun yaşar, ayrıca birinin satın aldığı plağın içindeki ölü kod sonradan düzeltebileceğin bir şey değildir.
