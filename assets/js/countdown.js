let countdownValue = window.countdownInitialValue;
const countdownElement = document.getElementById('countdown');
const countdownContainer = document.getElementById('countdown-container');
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
  countdownElement.textContent = countdownValue;
  countdownElement.classList.add('zoom');

  setTimeout(() => {
    countdownElement.classList.remove('zoom');
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

function toggleQRScanner() {
  if (scanning) {
    stopScanning();
  } else {
    startScanning();
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
      const video = document.getElementById('qr-video');
      const canvasElement = document.getElementById('qr-canvas');
      const canvas = canvasElement.getContext('2d');

      video.srcObject = stream;
      video.setAttribute('playsinline', true);
      video.play();
      video.style.display = 'block';
      document.getElementById('close-scanner').style.display = 'block';
      requestAnimationFrame(tick);

      function tick() {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvasElement.height = video.videoHeight;
          canvasElement.width = video.videoWidth;
          canvas.drawImage(
            video,
            0,
            0,
            canvasElement.width,
            canvasElement.height
          );
          var imageData = canvas.getImageData(
            0,
            0,
            canvasElement.width,
            canvasElement.height
          );
          var code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert',
          });
          if (code) {
            console.log('Found QR code', code.data);

            if (code.data.includes('/qr/')) {
              const qrCodeData = code.data.split('/');
              const qrCodeLink = qrCodeData[qrCodeData.length - 1];

              fetch(apiUri + '/qrlink/' + qrCodeLink)
                .then((response) => response.json())
                .then((data) => {
                  spotifyURI = convertToSpotifyURI(data.link);
                  stopScanning();
                  document.getElementById('qr-icon').style.display = 'none';
                  countdownContainer.style.display = 'block';
                  updateCountdown();
                })
                .catch((error) => {
                  console.error('Error:', error);
                });
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
  document.getElementById('qr-video').style.display = 'none';
  document.getElementById('close-scanner').style.display = 'none';
  document.getElementById('qr-icon').style.display = 'block';
  countdownContainer.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function () {
  if (isPWAInstalled()) {
    if (isCameraSupported() && !hasRequestedCameraPermission()) {
      // requestCameraPermission();
    }
    document.getElementById('qr-icon').style.display = 'block';
  } else {
    document.getElementById('onboarding-overlay').style.display = 'flex';
    document.getElementById('main-container').style.display = 'none';
  }

  document
    .getElementById('close-onboarding')
    .addEventListener('click', function () {
      document.getElementById('onboarding-overlay').style.display = 'none';
      document.getElementById('main-container').style.display = 'flex';
      document.getElementById('qr-icon').style.display = 'block';
      setOnboardingSeen();
    });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });

  window.addEventListener('appinstalled', (evt) => {
    console.log('PWA was installed');
    setOnboardingSeen();
  });
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
