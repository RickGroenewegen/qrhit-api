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
        setTimeout(() => {
          resetToInitialState();
        }, 1000); // Wait for 1 second before resetting the state
      } else {
        console.log(window.translations.cameraError);
        resetToInitialState();
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

  let html5QrCode;

  function startScanning() {
    scanning = true;
    $('#close-scanner').show();
    $('#qr-icon').hide();

    html5QrCode = new Html5Qrcode("qr-reader");
    const qrBoxSize = Math.min(window.innerWidth, window.innerHeight) * 0.7;

    html5QrCode.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: qrBoxSize
      },
      onScanSuccess,
      onScanFailure
    ).catch((err) => {
      console.error(`Unable to start scanning: ${err}`);
      alert("Error accessing the camera. Please make sure you've granted camera permissions.");
    });
  }

  function stopScanning() {
    if (html5QrCode) {
      html5QrCode.stop().then(() => {
        scanning = false;
        $('#close-scanner').hide();
        $('#qr-icon').show();
        $countdownContainer.hide();
      }).catch((err) => {
        console.error(`Unable to stop scanning: ${err}`);
      });
    }
  }

  function onScanSuccess(decodedText, decodedResult) {
    $countdownContainer.show();
    $('#qr-icon').hide();

    if (decodedText.includes('/qr/')) {
      const qrCodeData = decodedText.split('/');
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
    } else if (decodedText.includes('open.spotify.com')) {
      setTimeout(function () {
        spotifyURI = convertToSpotifyURI(decodedText);
        $countdownContainer.show();
        $('#qr-icon').hide();
        updateCountdown();
      }, 250);
    } else if (decodedText.includes('spotify:')) {
      setTimeout(function () {
        spotifyURI = decodedText;
        $countdownContainer.show();
        $('#qr-icon').hide();
        updateCountdown();
      }, 250);
    } else {
      alert(window.translations.invalidLink);
    }
    stopScanning();
  }

  function onScanFailure(error) {
    // Handle scan failure, if needed
    console.warn(`QR code scanning failed: ${error}`);
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

  function resetToInitialState() {
    countdownValue = window.countdownInitialValue;
    spotifyURI = null;
    $countdownContainer.hide();
    $('#qr-icon').show();
    stopScanning();
  }

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
