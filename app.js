/*
 * Hermes - Lógica principal de la aplicación
 *
 * Flujo de audio:
 * micrófono -> MediaStreamAudioSourceNode -> GainNode -> MediaStreamDestination
 *                                                     -> MediaRecorder
 *
 * El GainNode modifica el stream que se graba. No conectamos la ganancia a
 * audioContext.destination para evitar realimentación acústica (acople) por los
 * altavoces. La escucha de la grabación se hace posteriormente con <audio>.
 *
 * Limitación importante de la Web Speech API:
 * SpeechRecognition no acepta un MediaStream personalizado en la mayoría de
 * navegadores. Por ello, la transcripción usa el micrófono nativo del sistema,
 * mientras que MediaRecorder recibe el stream amplificado de Web Audio API.
 */

"use strict";

const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const gainRange = document.querySelector("#gainRange");
const gainValue = document.querySelector("#gainValue");
const meterFill = document.querySelector("#meterFill");
const levelValue = document.querySelector("#levelValue");
const meter = document.querySelector(".meter");
const transcript = document.querySelector("#transcript");
const audioContainer = document.querySelector("#audioContainer");
const recordingInfo = document.querySelector("#recordingInfo");
const statusPill = document.querySelector("#statusPill");
const statusText = document.querySelector("#statusText");
const speechSupport = document.querySelector("#speechSupport");
const mainView = document.querySelector("#mainView");
const instructionsView = document.querySelector("#instructionsView");
const instructionsButton = document.querySelector("#instructionsButton");
const backFromInstructions = document.querySelector("#backFromInstructions");
const showButton = document.querySelector("#showButton");
const showScreen = document.querySelector("#showScreen");
const exitShowButton = document.querySelector("#exitShowButton");
const showWords = document.querySelector("#showWords");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let audioContext = null;
let microphoneStream = null;
let microphoneSource = null;
let gainNode = null;
let analyser = null;
let amplifiedDestination = null;
let mediaRecorder = null;
let recordedChunks = [];
let animationFrameId = null;
let recognition = null;
let isCapturing = false;
let finalTranscript = "";
let recordingStartedAt = null;
let previousAudioUrl = null;

function getWordsFromTranscript() {
  return transcript.textContent.trim().split(/\s+/).filter(Boolean);
}

function updateShowWords() {
  const words = getWordsFromTranscript();
  if (!words.length) {
    showWords.innerHTML = '<span class="show-empty">Esperando palabras…</span>';
    return;
  }

  // Cada palabra recibe un índice visible para facilitar el seguimiento de la
  // secuencia hablada, incluso cuando SpeechRecognition entrega resultados
  // parciales que luego se actualizan.
  const fragment = document.createDocumentFragment();
  words.forEach((word, index) => {
    const item = document.createElement("span");
    item.className = "word-item";
    const number = document.createElement("small");
    number.className = "word-number";
    number.textContent = `${index + 1}.`;
    const text = document.createElement("span");
    text.textContent = word;
    item.append(number, text);
    fragment.append(item);
  });
  showWords.replaceChildren(fragment);
}

function openInstructions() {
  mainView.classList.add("is-hidden");
  instructionsView.classList.add("is-visible");
  instructionsView.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeInstructions() {
  instructionsView.classList.remove("is-visible");
  mainView.classList.remove("is-hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * Entra en la vista negra de lectura palabra por palabra.
 * Si todavía no existe una sesión, primero solicita el micrófono e inicia la
 * captura para que la pantalla pueda recibir la transcripción en tiempo real.
 */
async function mostrar() {
  closeInstructions();
  if (!isCapturing) {
    const captureStarted = await startCapture();
    if (!captureStarted) return;
  }
  updateShowWords();
  showScreen.classList.add("is-visible");
  showScreen.setAttribute("aria-hidden", "false");
  exitShowButton.focus();
}

function salirMostrar() {
  showScreen.classList.remove("is-visible");
  showScreen.setAttribute("aria-hidden", "true");
  showButton.focus();
}

function setStatus(message, state = "idle") {
  statusText.textContent = message;
  statusPill.dataset.state = state;
}

function updateGainLabel() {
  const value = Number(gainRange.value);
  gainValue.textContent = `${value.toFixed(1).replace(".0", "")}x`;
  if (gainNode) {
    gainNode.gain.setTargetAtTime(value, audioContext.currentTime, 0.015);
  }
}

function setLevel(level) {
  const percentage = Math.max(0, Math.min(100, Math.round(level)));
  meterFill.style.width = `${percentage}%`;
  levelValue.textContent = `${percentage}%`;
  meter.setAttribute("aria-valuenow", String(percentage));
}

function animateMeter() {
  if (!analyser || !isCapturing) {
    setLevel(0);
    return;
  }

  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);

  let sumSquares = 0;
  for (const sample of samples) {
    const normalizedSample = (sample - 128) / 128;
    sumSquares += normalizedSample * normalizedSample;
  }

  // Convertimos RMS a una escala visual no lineal para que los sonidos débiles
  // sigan siendo visibles en el medidor.
  const rms = Math.sqrt(sumSquares / samples.length);
  const visualLevel = Math.min(100, rms * 360);
  setLevel(visualLevel);
  animationFrameId = requestAnimationFrame(animateMeter);
}

function chooseRecordingMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4"
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function setupSpeechRecognition() {
  if (!SpeechRecognition) {
    speechSupport.textContent = "No disponible en este navegador";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "es-ES";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    speechSupport.textContent = "Escuchando micrófono nativo";
  };

  recognition.onresult = (event) => {
    let interimTranscript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) {
        finalTranscript += `${result[0].transcript.trim()} `;
      } else {
        interimTranscript += result[0].transcript;
      }
    }
    transcript.textContent = `${finalTranscript}${interimTranscript}`.trim();
    transcript.scrollTop = transcript.scrollHeight;
    updateShowWords();
  };

  recognition.onerror = (event) => {
    // "no-speech" y "aborted" son situaciones recuperables durante una
    // sesión; otros errores se muestran para que el usuario pueda actuar.
    if (event.error !== "no-speech" && event.error !== "aborted") {
      speechSupport.textContent = `Error de voz: ${event.error}`;
    }
  };

  recognition.onend = () => {
    speechSupport.textContent = isCapturing ? "Reiniciando escucha" : "Lista para escuchar";
    // Chrome puede finalizar una sesión continua por tiempo o silencio. La
    // reiniciamos solo mientras la captura principal siga activa.
    if (isCapturing) {
      try {
        recognition.start();
      } catch (error) {
        // Evita que una condición de carrera de la API interrumpa la grabación.
        console.debug("SpeechRecognition aún no puede reiniciarse", error);
      }
    }
  };
}

function startSpeechRecognition() {
  if (!recognition) return;
  try {
    recognition.start();
  } catch (error) {
    speechSupport.textContent = "La escucha de voz no pudo comenzar";
    console.debug("SpeechRecognition no pudo iniciarse", error);
  }
}

function stopSpeechRecognition() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch (error) {
    console.debug("SpeechRecognition ya estaba detenido", error);
  }
}

async function startCapture() {
  if (isCapturing) return true;

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Micrófono no compatible", "error");
    return false;
  }
  if (!window.AudioContext && !window.webkitAudioContext) {
    setStatus("Web Audio API no compatible", "error");
    return false;
  }
  if (!window.MediaRecorder) {
    setStatus("MediaRecorder no compatible", "error");
    return false;
  }

  startButton.disabled = true;
  setStatus("Solicitando permiso…", "idle");

  try {
    // Desactivamos el procesamiento automático para conservar control total
    // sobre la señal antes de aplicar nuestra propia ganancia.
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      },
      video: false
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
    await audioContext.resume();

    microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
    gainNode = audioContext.createGain();
    analyser = audioContext.createAnalyser();
    amplifiedDestination = audioContext.createMediaStreamDestination();

    gainNode.gain.value = Number(gainRange.value);
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;

    // El analizador recibe la señal original para representar el nivel de
    // entrada. La rama de grabación pasa por el GainNode y queda amplificada.
    microphoneSource.connect(analyser);
    microphoneSource.connect(gainNode);
    gainNode.connect(amplifiedDestination);

    const mimeType = chooseRecordingMimeType();
    mediaRecorder = mimeType
      ? new MediaRecorder(amplifiedDestination.stream, { mimeType })
      : new MediaRecorder(amplifiedDestination.stream);

    recordedChunks = [];
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    };
    mediaRecorder.onerror = () => setStatus("Error al grabar el audio", "error");
    mediaRecorder.onstop = createAudioPlayer;

    finalTranscript = "";
    transcript.textContent = "";
    updateShowWords();
    recordingStartedAt = Date.now();
    isCapturing = true;
    mediaRecorder.start(250);
    startSpeechRecognition();
    animateMeter();

    startButton.disabled = true;
    stopButton.disabled = false;
    setStatus("Capturando y amplificando", "active");
    return true;
  } catch (error) {
    cleanupAudioResources();
    startButton.disabled = false;
    stopButton.disabled = true;
    const message = error.name === "NotAllowedError"
      ? "Permiso de micrófono denegado"
      : "No se pudo iniciar el micrófono";
    setStatus(message, "error");
    console.error("Error al iniciar Hermes", error);
    return false;
  }
}

function stopCapture() {
  if (!isCapturing) return;

  isCapturing = false;
  stopSpeechRecognition();
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  animationFrameId = null;
  setLevel(0);

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  } else {
    cleanupAudioResources();
  }

  stopButton.disabled = true;
  startButton.disabled = false;
  setStatus("Procesando grabación", "idle");
}

function createAudioPlayer() {
  const mimeType = mediaRecorder?.mimeType || "audio/webm";
  const blob = new Blob(recordedChunks, { type: mimeType });
  const audioUrl = URL.createObjectURL(blob);

  if (previousAudioUrl) URL.revokeObjectURL(previousAudioUrl);
  previousAudioUrl = audioUrl;

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  audio.src = audioUrl;
  audio.setAttribute("aria-label", "Grabación amplificada de Hermes");

  audioContainer.replaceChildren(audio);
  const seconds = recordingStartedAt ? Math.max(0, Math.round((Date.now() - recordingStartedAt) / 1000)) : 0;
  recordingInfo.textContent = `${seconds}s · ${formatBytes(blob.size)}`;
  setStatus("Grabación lista para reproducir", "idle");
  cleanupAudioResources();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function cleanupAudioResources() {
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  microphoneSource?.disconnect();
  gainNode?.disconnect();
  analyser?.disconnect();
  amplifiedDestination?.disconnect?.();
  microphoneSource = null;
  gainNode = null;
  analyser = null;
  amplifiedDestination = null;
  if (audioContext && audioContext.state !== "closed") audioContext.close();
  audioContext = null;
  mediaRecorder = null;
}

gainRange.addEventListener("input", updateGainLabel);
startButton.addEventListener("click", startCapture);
stopButton.addEventListener("click", stopCapture);
showButton.addEventListener("click", mostrar);
exitShowButton.addEventListener("click", salirMostrar);
instructionsButton.addEventListener("click", openInstructions);
backFromInstructions.addEventListener("click", closeInstructions);

setupSpeechRecognition();
updateGainLabel();

// El service worker permite abrir la interfaz sin red después de la primera
// visita. El registro solo se intenta en contextos seguros (HTTPS o localhost).
if ("serviceWorker" in navigator && (window.isSecureContext || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
      .then((registration) => {
        // Comprueba si existe una versión nueva del service worker cada vez
        // que se abre Hermes, evitando que una instalación conserve código
        // antiguo indefinidamente.
        registration.update();
      })
      .catch((error) => {
        console.warn("No se pudo registrar el service worker", error);
      });
  });
} else if (location.protocol === "file:") {
  // Los archivos descargados y abiertos directamente no tienen origen seguro.
  // El aviso evita que el usuario confunda ese modo con una PWA instalada.
  setStatus("Abre Hermes desde HTTPS o localhost", "error");
}
