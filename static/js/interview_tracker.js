/**
 * AI-Proctored Live Interview Eye & Gaze Tracking Engine
 * Features:
 * - Intelligent Camera Selection (auto-prioritizes Laptop Webcam over Phone Camera)
 * - Live Screen Sharing Proctoring & Disconnect Detection
 * - Enforces continuous laptop screen gaze monitoring via MediaPipe FaceMesh
 * - Automatically closes and terminates interview on 15 look-away violations
 */

class InterviewProctor {
    constructor(sessionId, maxViolations = 15) {
        this.sessionId = sessionId;
        this.maxViolations = maxViolations;
        this.violationsCount = 0;
        this.isTerminated = false;
        this.isCompleted = false;

        // Computer Vision & Video Stream
        this.faceMesh = null;
        this.mediaStream = null;
        this.isCameraRunning = false;
        this.animFrameId = null;
        this.videoElement = document.getElementById('proctorVideo');
        this.canvasElement = document.getElementById('proctorCanvas');
        this.canvasCtx = this.canvasElement ? this.canvasElement.getContext('2d') : null;

        // Camera Device Selection
        this.availableCameras = [];
        this.selectedCameraId = null;

        // Screen Sharing Stream
        this.screenStream = null;
        this.screenVideoElement = document.getElementById('screenShareVideo');

        // Smart Laptop Screen Gaze Tracking & Calibration
        const savedH = parseFloat(localStorage.getItem('interview_calibrated_h'));
        const savedV = parseFloat(localStorage.getItem('interview_calibrated_v'));
        this.baselineH = (!isNaN(savedH) && savedH >= 0.35 && savedH <= 0.65) ? savedH : 0.50;
        this.baselineV = (!isNaN(savedV) && savedV >= 0.38 && savedV <= 0.65) ? savedV : 0.52; // Neutral laptop gaze (screen is below webcam)
        
        // Laptop Screen Coverage Span: allows reading questions on right and viewing camera on left
        this.horizontalSpan = 0.16;   // baselineH +/- 0.16 covers entire width of laptop screen
        this.verticalSpanUp = 0.18;   // covers up to webcam/top of screen
        this.verticalSpanDown = 0.18; // covers down to bottom of screen/answers
        
        this.isCalibrating = false;
        this.calibrationSamples = [];

        // Balanced Anti-Cheat Timers (Prevents false warnings on blinks & reading while stopping cheaters)
        this.initialGraceMs = 1200;        // 1.2s response: avoids false positives on blinks (150-250ms) and reading questions
        this.subsequentIntervalMs = 900;   // Marks subsequent violation every 900ms of sustained look-away
        this.safeHoldToResetMs = 1500;     // Candidate must maintain continuous screen gaze for 1.5s to clear debt buffer
        
        this.isCurrentlyOffCenter = false;
        this.accumulatedOffCenterMs = 0;   // Cumulative gaze debt buffer (kills flicker-glance loophole)
        this.lastOffCenterFrameTime = 0;
        this.lastCenterReturnTime = 0;
        this.lastWarningMarkedDebt = 0;

        // Rapid Micro-Glance (Peeking) Pattern Detector
        this.glanceTimestamps = [];        // Recent off-center glance timestamps (sliding 10s window)
        this.lastMicroGlanceWarning = 0;   // Throttle for micro-glance violation alert

        this.currentGazeState = 'LOOKING AT LAPTOP';
        this.currentViolationReason = '';
        this.lastVoiceAlertTime = 0;
        this.flashBannerTimeout = null;

        // Audio
        this.audioCtx = null;
        this.synth = window.speechSynthesis || null;

        this.init();
    }

    init() {
        this.setupAudio();
        this.setupEventListeners();
        this.setupScreenShareControls();
        this.startCamera();
        this.updateViolationUI();
    }

    /* -------------------------------------------------------------
     * AUDIO & VOICE ALERTS
     * ----------------------------------------------------------- */
    setupAudio() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                this.audioCtx = new AudioContext();
            }
        } catch (e) {}
    }

    resumeAudio() {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
    }

    playWarningChime() {
        this.resumeAudio();
        if (!this.audioCtx) return;
        try {
            const now = this.audioCtx.currentTime;
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(550, now);
            osc.frequency.setValueAtTime(440, now + 0.15);
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
            osc.connect(gain);
            gain.connect(this.audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.35);
        } catch (e) {}
    }

    playTerminationSiren() {
        this.resumeAudio();
        if (!this.audioCtx) return;
        try {
            const now = this.audioCtx.currentTime;
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(880, now);
            osc.frequency.linearRampToValueAtTime(300, now + 0.6);
            gain.gain.setValueAtTime(0.35, now);
            gain.gain.linearRampToValueAtTime(0.01, now + 0.8);
            osc.connect(gain);
            gain.connect(this.audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.8);
        } catch (e) {}
    }

    speakAlert(text) {
        if (!this.synth) return;
        try {
            this.synth.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 1.0;
            utterance.pitch = 1.0;
            this.synth.speak(utterance);
        } catch (e) {}
    }

    /* -------------------------------------------------------------
     * CAMERA SELECTION & HARDWARE DEVICE ENUMERATION
     * ----------------------------------------------------------- */
    async getAvailableCameras() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(d => d.kind === 'videoinput');
        } catch (e) {
            console.error('Error enumerating cameras:', e);
            return [];
        }
    }

    pickBestLaptopCamera(cameras) {
        if (!cameras || cameras.length === 0) return null;

        // 1. Check if user already manually chose a preferred camera previously
        const savedId = localStorage.getItem('interview_preferred_camera_id');
        if (savedId && cameras.some(c => c.deviceId === savedId)) {
            return savedId;
        }

        // Keywords indicating built-in laptop webcams
        const laptopKeywords = [
            'integrated', 'internal', 'builtin', 'built-in', 'laptop', 
            'webcam', 'hd camera', 'pc camera', 'chicony', 'realtek', 
            'sunplus', 'front', 'hp wide vision', 'easycamera'
        ];

        // Keywords indicating virtual or connected phone cameras
        const phoneKeywords = [
            'phone', 'link', 'droidcam', 'iriun', 'camo', 'epoccam', 
            'virtual', 'obs', 'android', 'apple', 'ios', 'connected camera'
        ];

        // Match 1: Look for camera with laptop keywords
        for (const cam of cameras) {
            const label = (cam.label || '').toLowerCase();
            if (laptopKeywords.some(kw => label.includes(kw))) {
                return cam.deviceId;
            }
        }

        // Match 2: Look for camera that does NOT have phone/virtual keywords
        for (const cam of cameras) {
            const label = (cam.label || '').toLowerCase();
            if (!phoneKeywords.some(kw => label.includes(kw))) {
                return cam.deviceId;
            }
        }

        // Match 3: Default to first device
        return cameras[0].deviceId;
    }

    populateCameraDropdown(cameras, activeDeviceId) {
        const select = document.getElementById('cameraSelect');
        if (!select) return;

        select.innerHTML = '';

        if (!cameras || cameras.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No webcams detected';
            select.appendChild(opt);
            return;
        }

        cameras.forEach((cam, index) => {
            const opt = document.createElement('option');
            opt.value = cam.deviceId;
            const label = cam.label || `Camera ${index + 1}`;
            const isLaptop = /integrated|internal|builtin|built-in|laptop|webcam|hd|front/i.test(label);
            const isPhone = /phone|link|droidcam|iriun|camo|virtual|obs/i.test(label);

            let tag = '';
            if (isLaptop) tag = ' (Laptop Webcam)';
            else if (isPhone) tag = ' (Phone / Virtual)';

            opt.textContent = `${label}${tag}`;
            if (cam.deviceId === activeDeviceId) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });

        // Add change listener if not already bound
        if (!select.dataset.bound) {
            select.dataset.bound = 'true';
            select.addEventListener('change', async (e) => {
                const newDeviceId = e.target.value;
                if (newDeviceId && newDeviceId !== this.selectedCameraId) {
                    localStorage.setItem('interview_preferred_camera_id', newDeviceId);
                    await this.startCamera(newDeviceId);
                }
            });
        }
    }

    /* -------------------------------------------------------------
     * CAMERA STREAMING & MEDIAPIPE COMPUTER VISION
     * ----------------------------------------------------------- */
    async startCamera(preferredDeviceId = null) {
        const statusEl = document.getElementById('cameraStatusText');
        if (statusEl) statusEl.textContent = 'Initializing Laptop Camera...';

        this.stopCamera();

        try {
            if (typeof FaceMesh === 'undefined') {
                throw new Error('MediaPipe FaceMesh not loaded from CDN.');
            }

            // Initialize FaceMesh instance once
            if (!this.faceMesh) {
                this.faceMesh = new FaceMesh({
                    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
                });

                this.faceMesh.setOptions({
                    maxNumFaces: 2,
                    refineLandmarks: true, // Iris detection for exact gaze tracking
                    minDetectionConfidence: 0.5,
                    minTrackingConfidence: 0.5
                });

                this.faceMesh.onResults((results) => this.onFaceMeshResults(results));
            }

            // Enumerate cameras
            let cameras = await this.getAvailableCameras();

            // If device labels are empty (due to browser security before permission), request a quick permission
            if (cameras.length > 0 && !cameras[0].label) {
                try {
                    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    tempStream.getTracks().forEach(t => t.stop());
                    cameras = await this.getAvailableCameras();
                } catch (e) {}
            }

            this.availableCameras = cameras;
            const chosenDeviceId = preferredDeviceId || this.pickBestLaptopCamera(cameras);
            this.selectedCameraId = chosenDeviceId;

            this.populateCameraDropdown(cameras, chosenDeviceId);

            // Configure video constraints preferring chosen laptop camera
            const videoConstraints = chosenDeviceId
                ? { deviceId: { exact: chosenDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
                : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } };

            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                video: videoConstraints,
                audio: false
            });

            this.videoElement.srcObject = this.mediaStream;
            await this.videoElement.play();

            this.isCameraRunning = true;
            if (statusEl) statusEl.textContent = 'AI Eye Proctor Active';

            // Launch frame processing loop
            this.runFrameLoop();

            // Auto-calibrate screen gaze 1.2s after camera starts
            setTimeout(() => {
                if (this.isCameraRunning && !this.isTerminated && !this.isCompleted) {
                    this.startCalibration();
                }
            }, 1200);
        } catch (err) {
            console.error('Camera initialization error:', err);
            if (statusEl) statusEl.textContent = 'Camera Off / Simulation Mode';
            const alertBox = document.getElementById('proctorNotice');
            if (alertBox) {
                alertBox.innerHTML = `<strong>Camera Offline:</strong> Please grant webcam permission or select your laptop webcam in the camera selector above. You can also test with <strong>"Simulate Look-Away"</strong> or press key <strong>'L'</strong>.`;
                alertBox.classList.replace('alert-info', 'alert-warning');
            }
        }
    }

    runFrameLoop() {
        let isProcessing = false;
        const process = async () => {
            if (!this.isCameraRunning || this.isTerminated || this.isCompleted) return;

            if (!isProcessing && this.videoElement && this.videoElement.readyState >= 2) {
                isProcessing = true;
                try {
                    await this.faceMesh.send({ image: this.videoElement });
                } catch (e) {
                    console.warn('FaceMesh frame processing error:', e);
                } finally {
                    isProcessing = false;
                }
            }
            this.animFrameId = requestAnimationFrame(process);
        };
        this.animFrameId = requestAnimationFrame(process);
    }

    stopCamera() {
        this.isCameraRunning = false;
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        if (this.mediaStream) {
            try {
                this.mediaStream.getTracks().forEach(t => t.stop());
            } catch (e) {}
            this.mediaStream = null;
        }
        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }
        if (this.canvasCtx && this.canvasElement) {
            this.canvasCtx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
        }
    }

    /* -------------------------------------------------------------
     * LIVE SCREEN SHARING PROCTORING
     * ----------------------------------------------------------- */
    setupScreenShareControls() {
        const startBtn = document.getElementById('startScreenShareBtn');
        const stopBtn = document.getElementById('stopScreenShareBtn');

        if (startBtn) {
            startBtn.addEventListener('click', () => this.startScreenShare());
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopScreenShare(true));
        }

        const refreshCamBtn = document.getElementById('refreshCamerasBtn');
        if (refreshCamBtn) {
            refreshCamBtn.addEventListener('click', async () => {
                const cams = await this.getAvailableCameras();
                const laptopId = this.pickBestLaptopCamera(cams);
                if (laptopId) {
                    localStorage.setItem('interview_preferred_camera_id', laptopId);
                    await this.startCamera(laptopId);
                }
            });
        }
    }

    async startScreenShare() {
        const badge = document.getElementById('screenShareBadge');
        const headerBadge = document.getElementById('headerScreenStatus');
        const prompt = document.getElementById('screenSharePrompt');
        const liveBadge = document.getElementById('screenLiveBadge');
        const stopBtn = document.getElementById('stopScreenShareBtn');
        const video = this.screenVideoElement;
        const infoText = document.getElementById('screenShareInfoText');

        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    displaySurface: "monitor",
                    cursor: "always"
                },
                audio: false
            });

            this.screenStream = stream;
            if (video) {
                video.srcObject = stream;
                video.classList.remove('d-none');
                await video.play();
            }

            if (prompt) prompt.classList.add('d-none');
            if (liveBadge) liveBadge.classList.remove('d-none');
            if (stopBtn) stopBtn.classList.remove('d-none');

            if (badge) {
                badge.className = 'badge bg-success-subtle text-success border border-success fw-bold';
                badge.innerHTML = '<i class="bi bi-display me-1"></i> Screen Sharing Active';
            }
            if (headerBadge) {
                headerBadge.className = 'badge bg-success fw-bold px-2.5 py-1.5';
                headerBadge.innerHTML = '<i class="bi bi-display me-1"></i> Screen Live';
            }
            if (infoText) {
                infoText.textContent = 'Screen sharing active and monitored in real-time.';
            }

            // Sync status with server
            await fetch(`/api/interview/${this.sessionId}/screenshare`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: true })
            });

            // Listen for native "Stop sharing" floating bar in browser
            const track = stream.getVideoTracks()[0];
            if (track) {
                track.onended = () => {
                    this.handleScreenShareStopped(false);
                };
            }
        } catch (err) {
            console.error('Screen sharing error:', err);
            if (infoText) {
                infoText.textContent = 'Screen share cancelled or permission denied. Please share your screen.';
            }
        }
    }

    async stopScreenShare(promptConfirm = true) {
        if (promptConfirm && !confirm('WARNING: Stopping screen share will be logged on your proctor audit report. Are you sure you want to stop?')) {
            return;
        }

        if (this.screenStream) {
            try {
                this.screenStream.getTracks().forEach(t => t.stop());
            } catch (e) {}
            this.screenStream = null;
        }

        this.handleScreenShareStopped(true);
    }

    async handleScreenShareStopped(wasManual = false) {
        const badge = document.getElementById('screenShareBadge');
        const headerBadge = document.getElementById('headerScreenStatus');
        const prompt = document.getElementById('screenSharePrompt');
        const liveBadge = document.getElementById('screenLiveBadge');
        const stopBtn = document.getElementById('stopScreenShareBtn');
        const video = this.screenVideoElement;
        const infoText = document.getElementById('screenShareInfoText');

        if (video) {
            video.srcObject = null;
            video.classList.add('d-none');
        }
        if (prompt) prompt.classList.remove('d-none');
        if (liveBadge) liveBadge.classList.add('d-none');
        if (stopBtn) stopBtn.classList.add('d-none');

        if (badge) {
            badge.className = 'badge bg-danger-subtle text-danger border border-danger-subtle fw-bold';
            badge.innerHTML = '<i class="bi bi-exclamation-triangle-fill me-1"></i> Screen Share Disconnected';
        }
        if (headerBadge) {
            headerBadge.className = 'badge bg-danger fw-bold px-2.5 py-1.5';
            headerBadge.innerHTML = '<i class="bi bi-display-slash me-1"></i> Screen Off';
        }
        if (infoText) {
            infoText.innerHTML = '<span class="text-danger fw-bold">⚠️ Screen share disconnected! Click button above to resume.</span>';
        }

        this.speakAlert('Screen sharing has stopped. Please re-share your screen immediately.');

        // Notify server and record audit warning
        try {
            const resp = await fetch(`/api/interview/${this.sessionId}/screenshare`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: false, log_warning: true })
            });
            const data = await resp.json();
            if (data.violations_count !== undefined) {
                this.violationsCount = data.violations_count;
                this.updateViolationUI();
                this.addViolationToLog(this.violationsCount, 'Candidate disconnected live screen sharing');
                if (data.status === 'terminated') {
                    this.triggerAutomaticTermination('Candidate disconnected screen share and reached maximum warnings.');
                }
            }
        } catch (e) {}
    }

    /* -------------------------------------------------------------
     * GAZE & OFF-SCREEN ANALYSIS (PRECISION EYEBALL & IRIS TRACKING)
     * ----------------------------------------------------------- */
    onFaceMeshResults(results) {
        if (this.isTerminated || this.isCompleted) return;
        if (!this.canvasCtx || !results.image) return;

        // Sync canvas buffer dimensions with actual video feed resolution for 1:1 pixel accuracy
        if (this.videoElement && this.videoElement.videoWidth > 0) {
            if (this.canvasElement.width !== this.videoElement.videoWidth || 
                this.canvasElement.height !== this.videoElement.videoHeight) {
                this.canvasElement.width = this.videoElement.videoWidth;
                this.canvasElement.height = this.videoElement.videoHeight;
            }
        }

        this.canvasCtx.save();
        this.canvasCtx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);

        const now = Date.now();
        let lookingAwayDetected = false;
        let violationReason = '';
        let gazeDescription = 'LOOKING AT LAPTOP SCREEN';

        // Check 1: Multiple Faces Detected
        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 1) {
            lookingAwayDetected = true;
            violationReason = 'Multiple people detected in interview frame';
            gazeDescription = 'MULTIPLE FACES DETECTED';
        }
        // Check 2: No Face Detected (Candidate left laptop)
        else if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
            lookingAwayDetected = true;
            violationReason = 'Face absent / Candidate left laptop view';
            gazeDescription = 'NO FACE IN FRAME';
        }
        // Check 3: Full Face Mesh & Eyeball Iris Tracking
        else {
            const landmarks = results.multiFaceLandmarks[0];

            // Perform precision gaze & eyeball analysis
            const gaze = this.analyzeGaze(landmarks);
            if (gaze.isOffScreen) {
                lookingAwayDetected = true;
                violationReason = gaze.reason;
                gazeDescription = gaze.direction;
            }

            // Draw real-time eyeball tracking reticles, eyelids, and HUD on canvas
            this.drawProctorLandmarks(landmarks, lookingAwayDetected, gazeDescription);
        }

        // Process sustained look-away with debounce & countdown bar
        this.processLookAway(lookingAwayDetected, violationReason, gazeDescription, now);

        this.canvasCtx.restore();
    }

    analyzeGaze(landmarks) {
        // Iris Centers (MediaPipe FaceMesh 468-477 mesh)
        const leftIris = landmarks[468];
        const rightIris = landmarks[473];

        // Eye Contours & Eyelids (Subject's Left Eye: viewer's right)
        const leftInner = landmarks[362];   // inner corner near nose
        const leftOuter = landmarks[263];   // outer corner near temple
        const leftUpper = landmarks[386];   // upper eyelid
        const leftLower = landmarks[374];   // lower eyelid

        // Eye Contours & Eyelids (Subject's Right Eye: viewer's left)
        const rightInner = landmarks[133];  // inner corner near nose
        const rightOuter = landmarks[33];   // outer corner near temple
        const rightUpper = landmarks[159];  // upper eyelid
        const rightLower = landmarks[145];  // lower eyelid

        // Key Facial Reference Landmarks
        const noseTip = landmarks[1];
        const leftCheek = landmarks[234];
        const rightCheek = landmarks[454];
        const forehead = landmarks[10];
        const chin = landmarks[152];

        // 1. Head Yaw (Turned Left / Right away from laptop)
        const minCheekX = Math.min(leftCheek.x, rightCheek.x);
        const cheekWidth = Math.abs(rightCheek.x - leftCheek.x) || 0.001;
        const noseRatio = (noseTip.x - minCheekX) / cheekWidth;

        if (noseRatio < 0.28) {
            return { isOffScreen: true, direction: 'HEAD TURNED RIGHT', reason: 'Head turned RIGHT away from laptop' };
        }
        if (noseRatio > 0.72) {
            return { isOffScreen: true, direction: 'HEAD TURNED LEFT', reason: 'Head turned LEFT away from laptop' };
        }

        // 2. Head Pitch (Head Tilted Down or Up away from laptop screen)
        // Laptop screen is naturally below the top webcam, so downward pitch up to 0.72 is normal screen reading
        const minForeheadY = Math.min(forehead.y, chin.y);
        const faceHeight = Math.abs(chin.y - forehead.y) || 0.001;
        const pitchRatio = (noseTip.y - minForeheadY) / faceHeight;

        if (pitchRatio > 0.72) {
            return { isOffScreen: true, direction: 'HEAD TILTED BOTTOM', reason: 'Head tilted DOWN away from laptop screen' };
        }
        if (pitchRatio < 0.25) {
            return { isOffScreen: true, direction: 'HEAD TILTED TOP', reason: 'Head tilted UP away from laptop screen' };
        }

        // 3. PRECISION EYEBALL & IRIS GAZE TRACKING (Full Laptop Screen Coverage)
        if (leftIris && rightIris && leftInner && leftOuter && rightInner && rightOuter && leftUpper && leftLower && rightUpper && rightLower) {
            // Horizontal Eyeball Position
            const leftMinX = Math.min(leftInner.x, leftOuter.x);
            const leftMaxX = Math.max(leftInner.x, leftOuter.x);
            const leftEyeW = Math.max(leftMaxX - leftMinX, 0.001);
            const leftH = (leftIris.x - leftMinX) / leftEyeW;

            const rightMinX = Math.min(rightInner.x, rightOuter.x);
            const rightMaxX = Math.max(rightInner.x, rightOuter.x);
            const rightEyeW = Math.max(rightMaxX - rightMinX, 0.001);
            const rightH = (rightIris.x - rightMinX) / rightEyeW;

            const avgH = (leftH + rightH) / 2;

            // Vertical Eyeball Position
            const leftMinY = Math.min(leftUpper.y, leftLower.y);
            const leftMaxY = Math.max(leftUpper.y, leftLower.y);
            const leftEyeH = Math.max(leftMaxY - leftMinY, 0.001);

            const rightMinY = Math.min(rightUpper.y, rightLower.y);
            const rightMaxY = Math.max(rightUpper.y, rightLower.y);
            const rightEyeH = Math.max(rightMaxY - rightMinY, 0.001);

            // Eyes closed / covered (ignore natural brief blinks)
            if (leftEyeH < 0.008 && rightEyeH < 0.008) {
                return { isOffScreen: true, direction: 'EYES CLOSED / COVERED', reason: 'Eyes closed or covered' };
            }

            const leftV = (leftIris.y - leftMinY) / leftEyeH;
            const rightV = (rightIris.y - rightMinY) / rightEyeH;
            const avgV = (leftV + rightV) / 2;

            // Calibration Sample Collection
            if (this.isCalibrating) {
                this.calibrationSamples.push({ h: avgH, v: avgV });
                if (this.calibrationSamples.length >= 25) {
                    const avgSampleH = this.calibrationSamples.reduce((s, a) => s + a.h, 0) / this.calibrationSamples.length;
                    const avgSampleV = this.calibrationSamples.reduce((s, a) => s + a.v, 0) / this.calibrationSamples.length;
                    this.baselineH = Math.min(Math.max(avgSampleH, 0.40), 0.60);
                    this.baselineV = Math.min(Math.max(avgSampleV, 0.42), 0.62);
                    this.isCalibrating = false;
                    localStorage.setItem('interview_calibrated_h', this.baselineH.toFixed(3));
                    localStorage.setItem('interview_calibrated_v', this.baselineV.toFixed(3));
                    this.flashCalibrationSuccess();
                }
                return { isOffScreen: false, direction: 'CALIBRATING SCREEN GAZE', reason: '' };
            }

            // Real-world Laptop Screen Field of View:
            // Allows reading questions on right and viewing camera on left without false warnings
            const minH = this.baselineH - this.horizontalSpan;
            const maxH = this.baselineH + this.horizontalSpan;
            const minV = this.baselineV - this.verticalSpanUp;
            const maxV = this.baselineV + this.verticalSpanDown;

            // Check Left/Right deviation away from laptop screen
            if (avgH > maxH) {
                return { isOffScreen: true, direction: 'EYEBALLS MOVED LEFT', reason: 'Eyeballs turned LEFT away from laptop' };
            }
            if (avgH < minH) {
                return { isOffScreen: true, direction: 'EYEBALLS MOVED RIGHT', reason: 'Eyeballs turned RIGHT away from laptop' };
            }

            // Check Top/Bottom deviation away from laptop screen
            if (avgV < minV) {
                return { isOffScreen: true, direction: 'EYEBALLS MOVED TOP', reason: 'Eyeballs tilted UP away from laptop screen' };
            }
            if (avgV > maxV) {
                return { isOffScreen: true, direction: 'EYEBALLS MOVED BOTTOM', reason: 'Eyeballs tilted DOWN away from laptop screen' };
            }
        }

        return { isOffScreen: false, direction: 'LOOKING AT LAPTOP SCREEN', reason: '' };
    }

    drawProctorLandmarks(landmarks, isOffScreen, gazeText) {
        const w = this.canvasElement.width;
        const h = this.canvasElement.height;
        const ctx = this.canvasCtx;

        const leftIris = landmarks[468];
        const rightIris = landmarks[473];

        const primaryColor = isOffScreen ? '#ef4444' : '#10b981';
        const glowColor = isOffScreen ? 'rgba(239, 68, 68, 0.45)' : 'rgba(16, 185, 129, 0.4)';

        // 1. Draw glowing reticles on both Eyeballs (Irises)
        [leftIris, rightIris].forEach(iris => {
            if (!iris) return;
            const x = iris.x * w;
            const y = iris.y * h;

            // Outer pulse circle
            ctx.beginPath();
            ctx.arc(x, y, 9, 0, 2 * Math.PI);
            ctx.fillStyle = glowColor;
            ctx.fill();

            // Iris ring
            ctx.beginPath();
            ctx.arc(x, y, 7, 0, 2 * Math.PI);
            ctx.strokeStyle = primaryColor;
            ctx.lineWidth = 2;
            ctx.stroke();

            // Pupil center
            ctx.beginPath();
            ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
            ctx.fillStyle = isOffScreen ? '#b91c1c' : '#ffffff';
            ctx.fill();

            // Precision crosshair lines
            ctx.beginPath();
            ctx.moveTo(x - 12, y);
            ctx.lineTo(x + 12, y);
            ctx.moveTo(x, y - 12);
            ctx.lineTo(x, y + 12);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        // 2. Draw eye contours to show active tracking mesh
        ctx.strokeStyle = isOffScreen ? 'rgba(239, 68, 68, 0.65)' : 'rgba(16, 185, 129, 0.6)';
        ctx.lineWidth = 1.5;

        // Right eye boundary
        const rightEye = [33, 160, 158, 133, 153, 144, 33];
        ctx.beginPath();
        rightEye.forEach((idx, i) => {
            const p = landmarks[idx];
            if (p) {
                if (i === 0) ctx.moveTo(p.x * w, p.y * h);
                else ctx.lineTo(p.x * w, p.y * h);
            }
        });
        ctx.stroke();

        // Left eye boundary
        const leftEye = [362, 385, 387, 263, 373, 380, 362];
        ctx.beginPath();
        leftEye.forEach((idx, i) => {
            const p = landmarks[idx];
            if (p) {
                if (i === 0) ctx.moveTo(p.x * w, p.y * h);
                else ctx.lineTo(p.x * w, p.y * h);
            }
        });
        ctx.stroke();

        // 3. Center Safe Target Guide Boxes on Eyes
        const leftInner = landmarks[362];
        const leftOuter = landmarks[263];
        const leftUpper = landmarks[386];
        const leftLower = landmarks[374];
        if (leftInner && leftOuter && leftUpper && leftLower) {
            const lMinX = Math.min(leftInner.x, leftOuter.x);
            const lW = Math.abs(leftOuter.x - leftInner.x);
            const lMinY = Math.min(leftUpper.y, leftLower.y);
            const lH = Math.abs(leftLower.y - leftUpper.y);
            
            // Dynamic Laptop Screen Safe Zone Guide Box
            const minH = this.baselineH - this.horizontalSpan;
            const minV = this.baselineV - this.verticalSpanUp;
            const wSpan = this.horizontalSpan * 2;
            const hSpan = this.verticalSpanUp + this.verticalSpanDown;

            const cx = (lMinX + minH * lW) * w;
            const cy = (lMinY + minV * lH) * h;
            const cw = (wSpan * lW) * w;
            const ch = (hSpan * lH) * h;
            
            ctx.strokeStyle = isOffScreen ? 'rgba(239, 68, 68, 0.65)' : 'rgba(16, 185, 129, 0.65)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(cx, cy, cw, ch);
        }

        const rightInner = landmarks[133];
        const rightOuter = landmarks[33];
        const rightUpper = landmarks[159];
        const rightLower = landmarks[145];
        if (rightInner && rightOuter && rightUpper && rightLower) {
            const rMinX = Math.min(rightInner.x, rightOuter.x);
            const rW = Math.abs(rightOuter.x - rightInner.x);
            const rMinY = Math.min(rightUpper.y, rightLower.y);
            const rH = Math.abs(rightLower.y - rightUpper.y);
            
            const minH = this.baselineH - this.horizontalSpan;
            const minV = this.baselineV - this.verticalSpanUp;
            const wSpan = this.horizontalSpan * 2;
            const hSpan = this.verticalSpanUp + this.verticalSpanDown;

            const rcx = (rMinX + minH * rW) * w;
            const rcy = (rMinY + minV * rH) * h;
            const rcw = (wSpan * rW) * w;
            const rch = (hSpan * rH) * h;
            
            ctx.strokeStyle = isOffScreen ? 'rgba(239, 68, 68, 0.65)' : 'rgba(16, 185, 129, 0.65)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(rcx, rcy, rcw, rch);
        }

        // 4. Subtle facial orientation landmarks
        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        [1, 10, 152, 234, 454].forEach(idx => {
            const pt = landmarks[idx];
            if (pt) {
                ctx.beginPath();
                ctx.arc(pt.x * w, pt.y * h, 2, 0, 2 * Math.PI);
                ctx.fill();
            }
        });

        // 5. On-Canvas Eyeball Tracking HUD Badge & Direction Indicator
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);

        const elapsedSec = (this.accumulatedOffCenterMs / 1000).toFixed(1);

        let hudText;
        if (this.isCalibrating) {
            hudText = `🎯 CALIBRATING SCREEN GAZE (${this.calibrationSamples.length}/25)...`;
        } else if (isOffScreen) {
            hudText = `⚠️ ${gazeText} [${elapsedSec}s]`;
        } else {
            hudText = `🟢 LOOKING AT LAPTOP SCREEN`;
        }

        ctx.font = 'bold 12px "Segoe UI", Arial, sans-serif';
        const textWidth = ctx.measureText(hudText).width;

        // HUD background pill
        ctx.fillStyle = isOffScreen ? 'rgba(220, 38, 38, 0.92)' : 'rgba(15, 23, 42, 0.82)';
        ctx.beginPath();
        ctx.roundRect(10, 10, textWidth + 18, 26, [6]);
        ctx.fill();

        // HUD text
        ctx.fillStyle = '#ffffff';
        ctx.fillText(hudText, 18, 27);

        // 6. Real-Time Eyeball Direction Cross Navigator (Bottom-Right HUD)
        const crossX = w - 65;
        const crossY = h - 60;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.beginPath();
        ctx.roundRect(crossX - 5, crossY - 5, 60, 55, [6]);
        ctx.fill();

        ctx.font = 'bold 9px "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'center';

        // TOP indicator
        ctx.fillStyle = gazeText.includes('TOP') ? '#ef4444' : 'rgba(255,255,255,0.4)';
        ctx.fillText('▲ TOP', crossX + 25, crossY + 9);

        // CENTER indicator
        ctx.fillStyle = !isOffScreen ? '#10b981' : 'rgba(255,255,255,0.3)';
        ctx.fillText('• CTR •', crossX + 25, crossY + 24);

        // BOTTOM indicator
        ctx.fillStyle = gazeText.includes('BOTTOM') ? '#ef4444' : 'rgba(255,255,255,0.4)';
        ctx.fillText('▼ BTM', crossX + 25, crossY + 39);

        // LEFT / RIGHT indicator dots
        ctx.fillStyle = gazeText.includes('LEFT') ? '#ef4444' : 'rgba(255,255,255,0.3)';
        ctx.fillText('◄', crossX + 7, crossY + 24);

        ctx.fillStyle = gazeText.includes('RIGHT') ? '#ef4444' : 'rgba(255,255,255,0.3)';
        ctx.fillText('►', crossX + 43, crossY + 24);

        ctx.restore();
    }

    processLookAway(detected, reason, description, now) {
        const statusBadge = document.getElementById('liveGazeStatus');
        const alertBox = document.getElementById('activeLookAwayAlert');
        const alertText = document.getElementById('activeLookAwayAlertText');
        const countdownBar = document.getElementById('lookAwayWarningBar');

        // If calibrating, skip look-away accumulation
        if (this.isCalibrating) {
            if (countdownBar) countdownBar.style.width = '0%';
            if (alertBox) alertBox.classList.add('d-none');
            return;
        }

        if (detected) {
            if (!this.isCurrentlyOffCenter) {
                this.isCurrentlyOffCenter = true;
                this.lastOffCenterFrameTime = now;
                this.currentViolationReason = reason;

                // Log glance event for rapid micro-glance pattern detector (sliding 10s window)
                this.glanceTimestamps.push(now);
                this.glanceTimestamps = this.glanceTimestamps.filter(t => now - t <= 10000);

                // Anti-Cheat Rule: 3 or more glances away from laptop within 10 seconds -> Cheating Violation
                if (this.glanceTimestamps.length >= 3 && (now - this.lastMicroGlanceWarning > 4000)) {
                    this.lastMicroGlanceWarning = now;
                    this.registerViolation('Rapid Micro-Glance Peeking Detected (Repeatedly looking away from laptop)');
                }
            }

            // Accumulate gaze debt
            const deltaMs = this.lastOffCenterFrameTime > 0 ? (now - this.lastOffCenterFrameTime) : 33;
            // Bounded delta protects against frame timing variance
            const boundedDelta = Math.min(Math.max(deltaMs, 10), 120);
            this.lastOffCenterFrameTime = now;
            this.accumulatedOffCenterMs += boundedDelta;

            // Progress bar fills over initialGraceMs (1200ms)
            const progress = Math.min((this.accumulatedOffCenterMs / this.initialGraceMs) * 100, 100);
            if (countdownBar) {
                countdownBar.style.width = progress + '%';
                countdownBar.className = this.accumulatedOffCenterMs >= this.initialGraceMs 
                    ? 'lookaway-indicator-bar bg-danger' 
                    : 'lookaway-indicator-bar bg-warning';
            }

            const debtSecStr = (this.accumulatedOffCenterMs / 1000).toFixed(1);

            if (statusBadge) {
                statusBadge.textContent = `⚠️ ${description} [${debtSecStr}s]`;
                statusBadge.className = 'badge bg-danger small animate__animated animate__pulse';
            }

            if (alertBox) {
                alertBox.classList.remove('d-none');
            }
            if (alertText) {
                alertText.innerHTML = `<strong>⚠️ Looking away from laptop screen (${debtSecStr}s):</strong> Return your focus to the laptop screen to avoid warning penalties!`;
            }

            // CONTINUOUS OFF-SCREEN PENALTY MARKING:
            // 1st warning at initialGraceMs (1.2s - accommodates natural eye blinks and reading question text)
            // Subsequent warnings mark every 900ms of sustained off-screen debt
            if (this.accumulatedOffCenterMs >= this.initialGraceMs) {
                const excessTime = this.accumulatedOffCenterMs - this.initialGraceMs;
                const currentTier = 1 + Math.floor(excessTime / this.subsequentIntervalMs);

                if (currentTier > this.lastWarningMarkedDebt) {
                    this.lastWarningMarkedDebt = currentTier;
                    const violationDesc = `${reason || 'Looking away from laptop'} (${debtSecStr}s off-screen)`;
                    this.registerViolation(violationDesc);
                }
            }
        } else {
            // Eyeballs currently in CENTER
            if (this.isCurrentlyOffCenter) {
                this.isCurrentlyOffCenter = false;
                this.lastOffCenterFrameTime = 0;
                this.lastCenterReturnTime = now;
            }

            // ANTI-FLICKER CHEAT PROTECTION:
            // Glancing back to center for 30ms does NOT reset accumulated look-away debt to 0!
            // Candidate must hold continuous center gaze for safeHoldToResetMs (1.8s)
            const centerHoldTime = now - this.lastCenterReturnTime;

            if (this.accumulatedOffCenterMs > 0) {
                if (centerHoldTime >= this.safeHoldToResetMs) {
                    // Full recovery achieved after 1.8s uninterrupted center eye contact
                    this.accumulatedOffCenterMs = 0;
                    this.lastWarningMarkedDebt = 0;

                    if (countdownBar) {
                        countdownBar.style.width = '0%';
                        countdownBar.className = 'lookaway-indicator-bar';
                    }
                    if (alertBox) {
                        alertBox.classList.add('d-none');
                    }
                } else {
                    // Probationary period: decay the bar visually so candidate knows they must hold center
                    const remainingRatio = 1 - (centerHoldTime / this.safeHoldToResetMs);
                    if (countdownBar) {
                        countdownBar.style.width = (remainingRatio * 100) + '%';
                        countdownBar.className = 'lookaway-indicator-bar bg-info';
                    }
                    if (alertText) {
                        const holdSecRemaining = ((this.safeHoldToResetMs - centerHoldTime) / 1000).toFixed(1);
                        alertText.innerHTML = `<strong>Stabilizing Center Contact:</strong> Keep eyes locked in center for ${holdSecRemaining}s to clear off-center penalty buffer.`;
                    }
                }
            } else {
                if (countdownBar) countdownBar.style.width = '0%';
                if (alertBox) alertBox.classList.add('d-none');
            }

            if (statusBadge) {
                if (this.accumulatedOffCenterMs > 0) {
                    const remainingSec = ((this.safeHoldToResetMs - centerHoldTime) / 1000).toFixed(1);
                    statusBadge.textContent = `🟢 STABILIZING SCREEN GAZE (${remainingSec}s)`;
                    statusBadge.className = 'badge bg-warning text-dark small';
                } else {
                    statusBadge.textContent = '🟢 LOOKING AT LAPTOP SCREEN';
                    statusBadge.className = 'badge bg-success small';
                }
            }
        }
    }

    async registerViolation(reason) {
        if (this.isTerminated || this.isCompleted) return;

        // Immediate audio warning chime
        this.playWarningChime();

        // Optimistic UI increment so candidate sees warning update instantly on-screen every second
        this.violationsCount++;
        this.updateViolationUI();
        this.addViolationToLog(this.violationsCount, reason);
        this.flashWarningBanner(this.violationsCount, reason);

        // Voice alert throttled so speech doesn't clash every single second
        const now = Date.now();
        if (now - this.lastVoiceAlertTime > 2500) {
            this.lastVoiceAlertTime = now;
            const remaining = Math.max(this.maxViolations - this.violationsCount, 0);
            if (remaining > 0) {
                this.speakAlert(`Warning ${this.violationsCount} of 15! Look at screen!`);
            }
        }

        // Automated termination check on 15 warnings
        if (this.violationsCount >= this.maxViolations) {
            this.triggerAutomaticTermination(reason || 'Exceeded 15 look-away warnings.');
        }

        // Sync with backend database
        try {
            const response = await fetch(`/api/interview/${this.sessionId}/violation`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    violation_type: 'looked_away',
                    description: reason || 'Candidate looked away from laptop screen'
                })
            });

            const data = await response.json();
            if (data && data.violations_count !== undefined) {
                this.violationsCount = data.violations_count;
                this.updateViolationUI();
            }

            if (data && (data.terminated || this.violationsCount >= this.maxViolations)) {
                this.triggerAutomaticTermination(data.message || 'Exceeded 15 look-away warnings.');
            }
        } catch (err) {
            console.error('Error syncing violation with server:', err);
        }
    }

    triggerAutomaticTermination(reason) {
        if (this.isTerminated) return;
        this.isTerminated = true;

        this.stopCamera();
        if (this.screenStream) {
            try { this.screenStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        }
        this.playTerminationSiren();

        // Announce closure
        this.speakAlert('Interview automatically terminated. You have exceeded 15 look-away warnings.');

        // Update Backend
        fetch(`/api/interview/${this.sessionId}/terminate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }).catch(() => {});

        // Display Fullscreen Automatic Termination Overlay
        this.showTerminationScreen(reason);
    }

    showTerminationScreen(reason) {
        // Disable interview workspace inputs
        document.querySelectorAll('textarea, input, button:not(#summaryBtn)').forEach(el => {
            el.disabled = true;
        });

        const overlay = document.getElementById('terminationOverlay');
        const countSpan = document.getElementById('finalViolationCount');
        const reasonSpan = document.getElementById('terminationReasonText');
        const timeSpan = document.getElementById('terminationTimeText');

        if (countSpan) countSpan.textContent = this.violationsCount;
        if (reasonSpan) reasonSpan.textContent = reason || 'Candidate looked away from laptop screen more than 15 times.';
        if (timeSpan) timeSpan.textContent = new Date().toLocaleTimeString();

        if (overlay) {
            overlay.classList.remove('d-none');
            overlay.scrollIntoView({ behavior: 'smooth' });
        }
    }

    updateViolationUI() {
        const countEl = document.getElementById('violationCountDisplay');
        const maxEl = document.getElementById('violationMaxDisplay');
        const progressEl = document.getElementById('violationProgressBar');
        const remainingEl = document.getElementById('violationsRemainingText');

        if (countEl) countEl.textContent = this.violationsCount;
        if (maxEl) maxEl.textContent = this.maxViolations;

        const pct = Math.min((this.violationsCount / this.maxViolations) * 100, 100);
        if (progressEl) {
            progressEl.style.width = pct + '%';
            if (this.violationsCount >= 12) {
                progressEl.className = 'progress-bar bg-danger progress-bar-striped progress-bar-animated';
            } else if (this.violationsCount >= 7) {
                progressEl.className = 'progress-bar bg-warning progress-bar-striped';
            } else {
                progressEl.className = 'progress-bar bg-info';
            }
        }

        const remaining = Math.max(this.maxViolations - this.violationsCount, 0);
        if (remainingEl) {
            remainingEl.textContent = `${remaining} remaining before auto-close`;
        }
    }

    addViolationToLog(num, desc) {
        const list = document.getElementById('liveViolationsList');
        if (!list) return;

        const emptyItem = document.getElementById('emptyViolationsMsg');
        if (emptyItem) emptyItem.remove();

        const timeStr = new Date().toLocaleTimeString();
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center py-2 px-3 border-danger-subtle bg-danger-subtle text-danger-emphasis mb-1 rounded';
        li.innerHTML = `
            <div>
                <strong>Warning #${num}:</strong> ${desc}
            </div>
            <span class="badge bg-danger">${timeStr}</span>
        `;
        list.prepend(li);
    }

    flashWarningBanner(num, reason) {
        const banner = document.getElementById('warningFlashBanner');
        const text = document.getElementById('warningFlashText');
        if (banner && text) {
            text.innerHTML = `<strong>LOOK-AWAY DETECTED (${num}/15)!</strong> ${reason}. Please keep your eyes on the laptop!`;
            banner.classList.remove('d-none');
            if (this.flashBannerTimeout) {
                clearTimeout(this.flashBannerTimeout);
            }
            this.flashBannerTimeout = setTimeout(() => {
                banner.classList.add('d-none');
            }, 2500);
        }
    }

    startCalibration() {
        this.isCalibrating = true;
        this.calibrationSamples = [];
        const statusBadge = document.getElementById('liveGazeStatus');
        if (statusBadge) {
            statusBadge.textContent = '🎯 CALIBRATING SCREEN GAZE... LOOK AT LAPTOP';
            statusBadge.className = 'badge bg-primary small animate__animated animate__pulse';
        }
        const notice = document.getElementById('activeLookAwayAlert');
        if (notice) notice.classList.add('d-none');
    }

    flashCalibrationSuccess() {
        const statusBadge = document.getElementById('liveGazeStatus');
        if (statusBadge) {
            statusBadge.textContent = '✅ SCREEN GAZE CALIBRATED';
            statusBadge.className = 'badge bg-success small animate__animated animate__bounceIn';
        }
        const banner = document.getElementById('warningFlashBanner');
        const text = document.getElementById('warningFlashText');
        if (banner && text) {
            text.innerHTML = `<strong>SCREEN CALIBRATED!</strong> AI proctor has tuned its tracking to your laptop screen position.`;
            banner.className = 'warning-flash-banner bg-success border-success text-white mb-3 d-flex align-items-center gap-2';
            banner.classList.remove('d-none');
            setTimeout(() => {
                banner.classList.add('d-none');
                banner.className = 'warning-flash-banner d-none mb-3 d-flex align-items-center gap-2';
            }, 3000);
        }
    }

    setupEventListeners() {
        // Tab Switching Detection (Alt+Tab or Minimized Browser Window)
        let lastFocusViolationTime = 0;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && !this.isTerminated && !this.isCompleted) {
                const now = Date.now();
                if (now - lastFocusViolationTime > 2500) {
                    lastFocusViolationTime = now;
                    this.registerViolation('Cheating Alert: Candidate switched browser tab or minimized window');
                }
            }
        });

        // 1-Click Screen Calibration Button
        const calibrateBtn = document.getElementById('calibrateGazeBtn');
        if (calibrateBtn) {
            calibrateBtn.addEventListener('click', () => {
                this.startCalibration();
            });
        }

        // Anti-Cheating: Question Copy/Cut Prevention (Prevents copying questions into AI/search tools)
        document.addEventListener('copy', (e) => {
            const isInput = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT';
            if (!isInput && !this.isTerminated && !this.isCompleted) {
                e.preventDefault();
                this.registerViolation('Cheating Alert: Unauthorized copy attempted on interview questions');
            }
        });

        document.addEventListener('cut', (e) => {
            const isInput = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT';
            if (!isInput && !this.isTerminated && !this.isCompleted) {
                e.preventDefault();
                this.registerViolation('Cheating Alert: Unauthorized cut attempted on interview content');
            }
        });

        document.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('textarea') && !e.target.closest('input')) {
                e.preventDefault();
            }
        });

        // Simulation key 'L' or test button
        window.addEventListener('keydown', (e) => {
            if (e.key === 'l' || e.key === 'L') {
                if (e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
                    this.registerViolation('Manual test look-away (Simulated)');
                }
            }
        });

        const simBtn = document.getElementById('simulateLookAwayBtn');
        if (simBtn) {
            simBtn.addEventListener('click', () => {
                this.registerViolation('Simulated off-screen glance (Test)');
            });
        }

        // Interview submission
        const submitBtn = document.getElementById('submitInterviewBtn');
        if (submitBtn) {
            submitBtn.addEventListener('click', async () => {
                if (this.isTerminated) return;
                if (!confirm('Are you sure you want to finish and submit your interview?')) return;

                this.isCompleted = true;
                this.stopCamera();
                if (this.screenStream) {
                    try { this.screenStream.getTracks().forEach(t => t.stop()); } catch (e) {}
                }

                const answers = {};
                document.querySelectorAll('.question-answer-box').forEach((ta, i) => {
                    answers[`q_${i + 1}`] = ta.value;
                });

                await fetch(`/api/interview/${this.sessionId}/submit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ answers })
                });

                const modal = document.getElementById('completionOverlay');
                if (modal) modal.classList.remove('d-none');
            });
        }
    }
}

// Global initialization helper
window.initInterviewProctor = function(sessionId, maxViolations) {
    window.proctor = new InterviewProctor(sessionId, maxViolations);
};
