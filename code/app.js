class ABRPlayer {
  constructor() {
    this.video = document.getElementById('videoPlayer');

    this.currentLevel = 2;
    this.segmentIndex = 0;
    this.bufferTime = 0;
    this.throughput = 0;
    this.smoothedThroughput = 0;
    this.throughputHistory = [];
    this.manifest = null;

    this.startupPhase = true;
    this.isLoading = false;

    this.manualOverrideLevel = null;
    this.manualOverridePending = false;

    this.charts = {
      bitrate: document.getElementById('bitrateChart'),
      buffer: document.getElementById('bufferChart'),
      throughput: document.getElementById('throughputChart')
    };

    this.lastDecision = 'START';

    this.history = {
      bitrate: [],
      buffer: [],
      throughput: []
    };

    this.init();
  }

  async init() {
    const response = await fetch('manifest.json');
    this.manifest = await response.json();

    this.updateUI();

    document.getElementById('quality240').onclick = () => this.setQuality(0);
    document.getElementById('quality480').onclick = () => this.setQuality(1);
    document.getElementById('quality720').onclick = () => this.setQuality(2);

    this.loadNextSegment();
  }

  getSmoothedThroughput(newValue) {
    this.throughputHistory.push(newValue);
    if (this.throughputHistory.length > 3) this.throughputHistory.shift();
    const sum = this.throughputHistory.reduce((a, b) => a + b, 0);
    return sum / this.throughputHistory.length;
  }

  async loadNextSegment() {
    if (this.isLoading) return;
    if (this.segmentIndex >= this.manifest.totalSegments) {
      console.log('End of stream');
      return;
    }

    this.isLoading = true;

    const fetchedLevelIndex = this.currentLevel;
    const fetchedLevel = this.manifest.levels[fetchedLevelIndex];
    const segmentUrl = fetchedLevel.segments[this.segmentIndex];

    console.log(
      `Fetching seg${this.segmentIndex} from ${fetchedLevel.name} | prev throughput=${this.throughput.toFixed(0)} kbps | buffer=${this.bufferTime.toFixed(1)}s`
    );

    try {
      const startTime = performance.now();
      const response = await fetch(segmentUrl);
      const arrayBuffer = await response.arrayBuffer();
      const endTime = performance.now();

      const duration = Math.max((endTime - startTime) / 1000, 0.001);
      this.throughput = (arrayBuffer.byteLength * 8 / 1000) / duration;
      this.smoothedThroughput = this.getSmoothedThroughput(this.throughput);

      this.video.src = segmentUrl;
      this.video.load();
      this.video.play().catch(err => console.log('Play failed:', err));

      this.bufferTime += this.manifest.segmentDuration;
      if (this.bufferTime > 30) this.bufferTime = 30;

      const decision = this.selectNextLevel(fetchedLevelIndex);

      this.history.bitrate.push(fetchedLevel.bitrate);
      this.history.buffer.push(this.bufferTime);
      this.history.throughput.push(this.throughput);

      this.updateLogTable({
        segment: this.segmentIndex,
        quality: fetchedLevel.name,
        bitrate: fetchedLevel.bitrate,
        throughput: this.throughput,
        buffer: this.bufferTime,
        decision: decision,
        nextQuality: this.manifest.levels[this.currentLevel].name
      });

      this.updateCharts();
      this.updateUI();

      this.segmentIndex++;

      setTimeout(() => {
        this.bufferTime = Math.max(0, this.bufferTime - this.manifest.segmentDuration);
        this.updateUI();
        this.updateCharts();
        this.isLoading = false;
        this.loadNextSegment();
      }, this.manifest.segmentDuration * 1000);

    } catch (err) {
      console.error('Segment load failed:', err);
      this.isLoading = false;
    }
  }

  selectNextLevel(fetchedLevelIndex) {
    const currentBitrate = this.manifest.levels[fetchedLevelIndex].bitrate;
    const tput = this.smoothedThroughput || this.throughput;

    if (this.startupPhase) {
      this.startupPhase = false;
      if (tput > 2200) {
        this.currentLevel = 2;
        this.lastDecision = 'START_720';
        return 'START_720';
      }
      if (tput > 1000) {
        this.currentLevel = 1;
        this.lastDecision = 'START_480';
        return 'START_480';
      }
      this.currentLevel = 0;
      this.lastDecision = 'START_240';
      return 'START_240';
    }

    if (this.manualOverridePending && this.manualOverrideLevel !== null) {
      this.currentLevel = this.manualOverrideLevel;
      this.manualOverridePending = false;
      this.manualOverrideLevel = null;
      this.lastDecision = 'MANUAL';
      return 'MANUAL';
    }

    this.currentLevel = fetchedLevelIndex;
    let decision = 'STAY';

    if (tput > currentBitrate * 1.8 && this.bufferTime >= 8) {
      const nextLevel = Math.min(fetchedLevelIndex + 1, this.manifest.levels.length - 1);
      if (nextLevel !== fetchedLevelIndex) {
        this.currentLevel = nextLevel;
        decision = 'UP';
      }
    } else if (tput < currentBitrate * 0.65 || this.bufferTime < 3) {
      const nextLevel = Math.max(fetchedLevelIndex - 1, 0);
      if (nextLevel !== fetchedLevelIndex) {
        this.currentLevel = nextLevel;
        decision = 'DOWN';
      }
    }

    this.lastDecision = decision;
    return decision;
  }

  setQuality(levelIndex) {
    this.manualOverrideLevel = levelIndex;
    this.manualOverridePending = true;
    this.lastDecision = 'MANUAL_PENDING';
    this.updateUI();
  }

  updateUI() {
    if (!this.manifest) return;

    const level = this.manifest.levels[this.currentLevel];
    let statusText = `${level.name} | seg${Math.min(this.segmentIndex, this.manifest.totalSegments - 1)}`;

    if (this.manualOverridePending && this.manualOverrideLevel !== null) {
      statusText += ` | next manual: ${this.manifest.levels[this.manualOverrideLevel].name}`;
    }

    document.getElementById('currentBitrate').textContent = statusText;
    document.getElementById('bufferTime').textContent = this.bufferTime.toFixed(1) + 's';
    document.getElementById('throughput').textContent = this.throughput.toFixed(0) + ' kbps';
  }

  drawChart(canvas, data, color, title, yLabel, yMax) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const left = 42;
    const right = 10;
    const top = 20;
    const bottom = 28;
    const chartWidth = w - left - right;
    const chartHeight = h - top - bottom;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#111';
    ctx.font = '12px Arial';
    ctx.fillText(title, 10, 12);

    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, h - bottom);
    ctx.lineTo(w - right, h - bottom);
    ctx.stroke();

    ctx.fillStyle = '#444';
    ctx.font = '10px Arial';
    for (let i = 0; i <= 4; i++) {
      const y = top + i * (chartHeight / 4);
      const value = Math.round(yMax - (i * yMax / 4));
      ctx.beginPath();
      ctx.moveTo(left - 4, y);
      ctx.lineTo(left, y);
      ctx.stroke();
      ctx.fillText(value, 4, y + 3);
    }

    const total = Math.max(data.length, 1);
    for (let i = 0; i < total; i++) {
      const x = left + (i * chartWidth / Math.max(total - 1, 1));
      ctx.beginPath();
      ctx.moveTo(x, h - bottom);
      ctx.lineTo(x, h - bottom + 4);
      ctx.stroke();
      ctx.fillText(i.toString(), x - 3, h - 8);
    }

    ctx.fillText('Segment', w / 2 - 18, h - 2);

    ctx.save();
    ctx.translate(10, h / 2 + 10);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    if (data.length === 0) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    data.forEach((value, index) => {
      const x = left + (index * chartWidth / Math.max(data.length - 1, 1));
      const y = h - bottom - ((Math.min(value, yMax) / yMax) * chartHeight);

      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();

    ctx.fillStyle = color;
    data.forEach((value, index) => {
      const x = left + (index * chartWidth / Math.max(data.length - 1, 1));
      const y = h - bottom - ((Math.min(value, yMax) / yMax) * chartHeight);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  updateCharts() {
    this.drawChart(this.charts.bitrate, this.history.bitrate, '#0b5ed7', 'Bitrate Over Time', 'kbps', 3000);
    this.drawChart(this.charts.buffer, this.history.buffer, '#198754', 'Buffer Over Time', 'seconds', 30);
    this.drawChart(this.charts.throughput, this.history.throughput, '#fd7e14', 'Throughput Over Time', 'kbps', 8000);
  }

  updateLogTable(entry) {
    const tbody = document.querySelector('#metricsTable tbody');
    if (!tbody) return;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${entry.segment}</td>
      <td>${entry.quality}</td>
      <td>${entry.bitrate}</td>
      <td>${entry.throughput.toFixed(0)}</td>
      <td>${entry.buffer.toFixed(1)}</td>
      <td>${entry.decision}</td>
    `;
    tbody.appendChild(row);
  }
}

new ABRPlayer();