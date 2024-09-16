$(document).ready(function () {
  let countdownValue = window.countdownInitialValue;
  const $countdownElement = $('#countdown');
  const $countdownContainer = $('#countdown-container');
  const environment = window.environment;
  const apiUri = window.apiUri;

  let deferredPrompt;
  let spotifyURI;
  let scanning = false;
  let videoStream;

  function isPWAInstalled() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone ||
      document.referrer.includes('android-app://')
    );
  }

  function toggleQRScanner() {
    if (scanning) {
      stopScanning();
    } else {
      startScanning();
    }
  }

  function hasSeenOnboarding() {
    return localStorage.getItem('hasSeenOnboarding') === 'true';
  }

  function setOnboardingSeen() {
    localStorage.setItem('hasSeenOnboarding', 'true');
  }

  function isCameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function hasRequestedCameraPermission() {
    return localStorage.getItem('hasRequestedCameraPermission') === 'true';
  }

  function setRequestedCameraPermission() {
    localStorage.setItem('hasRequestedCameraPermission', 'true');
  }

  function updateCountdown() {
    $countdownElement.text(countdownValue).addClass('zoom');

    setTimeout(() => {
      $countdownElement.removeClass('zoom');
    }, 300);

    if (countdownValue > 0) {
      countdownValue--;
      setTimeout(updateCountdown, 1000);
    } else {
      if (spotifyURI) {
        console.log('Redirecting to Spotify URI:', spotifyURI);
        window.location.href = spotifyURI;
        countdownValue = window.countdownInitialValue;
        stopScanning();
      } else {
        console.log(window.translations.cameraError);
      }
    }
  }

  function convertToSpotifyURI(url) {
    const spotifyWebUrlPattern =
      /^https?:\/\/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)(.*)$/;
    const match = url.match(spotifyWebUrlPattern);

    if (match) {
      const [, type, id] = match;
      return `spotify:${type}:${id}`;
    }

    return url; // Return original URL if it doesn't match the pattern
  }

  function startScanning() {
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (stream) {
        scanning = true;
        videoStream = stream;
        const $video = $('#qr-video');
        const $canvasElement = $('#qr-canvas');
        const canvas = $canvasElement[0].getContext('2d');

        $video[0].srcObject = stream;
        $video.attr('playsinline', true);
        $video[0].play();
        $video.show();
        $('#close-scanner').show();
        requestAnimationFrame(tick);

        function tick() {
          if ($video[0].readyState === $video[0].HAVE_ENOUGH_DATA) {
            $canvasElement[0].height = $video[0].videoHeight;
            $canvasElement[0].width = $video[0].videoWidth;
            canvas.drawImage(
              $video[0],
              0,
              0,
              $canvasElement[0].width,
              $canvasElement[0].height
            );
            var imageData = canvas.getImageData(
              0,
              0,
              $canvasElement[0].width,
              $canvasElement[0].height
            );
            var code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert',
            });
            if (code) {
              $countdownContainer.show();
              $('#qr-icon').hide();
              if (code.data.includes('/qr/')) {
                const qrCodeData = code.data.split('/');
                const qrCodeLink = qrCodeData[qrCodeData.length - 1];
                $.ajax({
                  url: apiUri + '/qrlink/' + qrCodeLink,
                  method: 'GET',
                  dataType: 'json',
                  success: function (data) {
                    spotifyURI = convertToSpotifyURI(data.link);
                    $('#qr-icon').hide();
                    $countdownContainer.show();
                    updateCountdown();
                  },
                  error: function (error) {
                    console.error('Error:', error);
                  },
                });
              } else if (code.data.includes('open.spotify.com')) {
                setTimeout(function () {
                  spotifyURI = convertToSpotifyURI(code.data);
                  $countdownContainer.show();
                  $('#qr-icon').hide();
                  updateCountdown();
                }, 250);
              } else if (code.data.includes('spotify:')) {
                setTimeout(function () {
                  spotifyURI = code.data;
                  $countdownContainer.show();
                  $('#qr-icon').hide();
                  updateCountdown();
                }, 250);
              } else {
                alert(window.translations.invalidLink);
              }
              stopScanning();
            }
          }
          if (scanning) {
            requestAnimationFrame(tick);
          }
        }
      })
      .catch(function (error) {
        console.error('Error accessing the camera', error);
        alert(
          "Error accessing the camera. Please make sure you've granted camera permissions."
        );
      });
  }

  function stopScanning() {
    scanning = false;
    if (videoStream) {
      videoStream.getTracks().forEach((track) => track.stop());
    }
    $('#qr-video').hide();
    $('#close-scanner').hide();
    $('#qr-icon').show();
    $countdownContainer.hide();
  }

  if (isPWAInstalled()) {
    if (isCameraSupported() && !hasRequestedCameraPermission()) {
      // requestCameraPermission();
    }
    $('#qr-icon').show();
  } else {
    $('#onboarding-overlay').css('display', 'flex');
    $('#main-container').hide();
  }

  function showOnboarding() {
    $('#onboarding-overlay').css('display', 'flex');
    $('#main-container').hide();
  }

  function hideOnboarding() {
    $('#onboarding-overlay').hide();
    $('#main-container').css('display', 'flex');
    $('#qr-icon').show();
    setOnboardingSeen();
  }

  function setActiveDevice(device) {
    $('.device-button').removeClass('active');
    $(`#${device}-selector`).addClass('active');
    $('.install-instructions').removeClass('active');
    $(`#${device}-instructions`).addClass('active');
  }

  function detectOS() {
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    if (/android/i.test(userAgent)) {
      return 'android';
    }
    if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) {
      return 'ios';
    }
    return 'ios'; // Default to iOS if can't determine
  }

  $('#ios-selector').on('click', function () {
    setActiveDevice('ios');
  });

  $('#android-selector').on('click', function () {
    setActiveDevice('android');
  });

  $('#close-onboarding').on('click', hideOnboarding);

  if (!isPWAInstalled()) {
    showOnboarding();
    setActiveDevice(detectOS());
  } else {
    $('#main-container').css('display', 'flex');
    $('#qr-icon').show();
  }

  $('#qr-icon').on('click', toggleQRScanner);
  $('#close-scanner').on('click', stopScanning);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });

  window.addEventListener('appinstalled', (evt) => {
    console.log('PWA was installed');
    setOnboardingSeen();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/assets/js/sw.js')
        .then((registration) => {
          console.log(
            'Service Worker registered successfully:',
            registration.scope
          );
        })
        .catch((error) => {
          console.log('Service Worker registration failed:', error);
        });
    });
  }
});

// document.addEventListener('DOMContentLoaded', function () {
//   alert(isPWAInstalled());

//   const onboardingOverlay = document.getElementById('onboarding-overlay');

//   if (
//     localStorage.getItem('hasSeenOnboarding') === 'true' ||
//     isPWAInstalled()
//   ) {
//     onboardingOverlay.style.display = 'none';
//   }
// });
