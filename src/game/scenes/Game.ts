import * as Phaser from 'phaser';

type ChartNote = {
  time: number;
  lane: number;
  type: string;
};

type ChartData = {
  title: string;
  audio: string;
  offset: number;
  endTime: number;
  notes: ChartNote[];
};

type NoteObject = {
  time: number;
  lane: number;
  rect: Phaser.GameObjects.Rectangle;
  judged: boolean;
};

export class Game extends Phaser.Scene {
  private chart!: ChartData;
  private music!: Phaser.Sound.BaseSound;

  private notes: NoteObject[] = [];

  private score = 0;
  private combo = 0;
  private maxCombo = 0;

  private perfectCount = 0;
  private greatCount = 0;
  private goodCount = 0;
  private missCount = 0;

  private finished = false;

  private scoreText!: Phaser.GameObjects.Text;
  private comboText!: Phaser.GameObjects.Text;
  private judgmentText!: Phaser.GameObjects.Text;
  private highSpeedText!: Phaser.GameObjects.Text;

  private menuObjects: Phaser.GameObjects.GameObject[] = [];
  private isStartMenuOpen = true;

  private laneCount = 3;
  private gameWidth = 540;
  private gameHeight = 960;

  private judgmentLineY = 780;

  // HIGH SPEED 1.0 のとき、ノーツが2秒かけて判定ラインまで落ちる
  private baseAppearTime = 2.0;

  private highSpeed = 1.0;
  private minHighSpeed = 0.5;
  private maxHighSpeed = 8.0;
  private highSpeedStep = 0.5;

  private started = false;
  private startTime = 0;

  // 入力を一旦ここにためて、update内でまとめて処理する
  private inputLaneQueue: number[] = [];

  // スマホ同時押し用：
  // 現在押されているレーンと、前フレームで押されていたレーンを記録する
  private touchingLanes: Set<number> = new Set();
  private previousTouchingLanes: Set<number> = new Set();

  constructor() {
    super('Game');
  }

  preload() {
    this.load.json('chart', 'charts/sample.json');
    this.load.audio('song', 'audio/song.mp3');
  }

  create() {
    // リトライ後に古い入力イベントが残って干渉するのを防ぐ
    this.input.removeAllListeners();
    this.input.keyboard?.removeAllListeners();

    // scene.restart() 後も安全に動くように、ゲーム状態を明示的に初期化
    this.resetGameState();

    this.chart = this.cache.json.get('chart') as ChartData;

    this.cameras.main.setBackgroundColor('#111111');

    this.createLanes();
    this.createNotes();
    this.createTexts();
    this.createStartMenu();

    this.music = this.sound.add('song');

    // スマホの複数指タップ対応。
    // 標準の1本に加えて、追加で4本分のポインタを有効にする。
    this.input.addPointer(4);

    this.input.keyboard?.on('keydown-A', () => {
      this.queueLaneInput(1);
    });

    this.input.keyboard?.on('keydown-S', () => {
      this.queueLaneInput(2);
    });

    this.input.keyboard?.on('keydown-D', () => {
      this.queueLaneInput(3);
    });

    this.input.keyboard?.on('keydown-LEFT', () => {
      this.changeHighSpeed(-this.highSpeedStep);
    });

    this.input.keyboard?.on('keydown-RIGHT', () => {
      this.changeHighSpeed(this.highSpeedStep);
    });

    this.input.keyboard?.on('keydown-SPACE', () => {
      this.startGame();
    });

    this.input.keyboard?.on('keydown-ENTER', () => {
      this.startGame();
    });

    // 以前はここで pointerdown から直接 judgeLane() していましたが、
    // スマホ同時押しを安定させるため、ゲーム中のタップ判定は
    // update() 内の processActiveTouches() で行います。
    //
    // STARTボタンやRETRYボタンは、それぞれのボタン自体に
    // pointerdown が設定されているので、ここで画面全体の
    // pointerdown を使わなくても問題ありません。
  }

  private resetGameState() {
    this.notes = [];
    this.menuObjects = [];
    this.inputLaneQueue = [];

    this.touchingLanes.clear();
    this.previousTouchingLanes.clear();

    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;

    this.perfectCount = 0;
    this.greatCount = 0;
    this.goodCount = 0;
    this.missCount = 0;

    this.started = false;
    this.finished = false;
    this.isStartMenuOpen = true;

    this.startTime = 0;

    // highSpeed はあえてリセットしない。
    // リトライ後も前回選んだハイスピードを維持する。
  }

  update() {
    if (!this.started) return;
    if (this.finished) return;

    const songTime = this.getSongTime();

    // スマホ同時押し用：
    // 現在押されている指を毎フレーム調べる
    this.processActiveTouches();

    // キーボード入力・タッチ入力をまとめて判定する
    this.processQueuedInputs();

    if (songTime >= this.chart.endTime) {
      this.finishGame();
      return;
    }

    for (const note of this.notes) {
      if (note.judged) continue;

      const timeUntilHit = note.time - songTime;

      const startY = -100;
      const distance = this.judgmentLineY - startY;
      const appearTime = this.getAppearTime();

      note.rect.y =
        this.judgmentLineY - (timeUntilHit / appearTime) * distance;

      if (songTime - note.time > 0.2) {
        note.judged = true;
        note.rect.destroy();

        this.combo = 0;
        this.missCount++;

        this.showJudgment('がんばれ');
        this.updateScoreText();

        console.log('がんばれ');
      }
    }
  }

  private createLanes() {
    const laneWidth = this.gameWidth / this.laneCount;

    for (let i = 0; i < this.laneCount; i++) {
      const x = i * laneWidth;

      this.add.rectangle(
        x + laneWidth / 2,
        this.gameHeight / 2,
        laneWidth - 4,
        this.gameHeight,
        0x222222
      );

      this.add.rectangle(
        x + laneWidth / 2,
        this.judgmentLineY,
        laneWidth - 10,
        12,
        0xffffff
      );
    }
  }

  private createNotes() {
    const laneWidth = this.gameWidth / this.laneCount;

    for (const chartNote of this.chart.notes) {
      // laneは1始まり：
      // lane 1 = 左、lane 2 = 中央、lane 3 = 右
      const x = (chartNote.lane - 1) * laneWidth + laneWidth / 2;

      const rect = this.add.rectangle(
        x,
        -100,
        laneWidth - 30,
        32,
        0x66ccff
      );

      this.notes.push({
        time: chartNote.time + this.chart.offset,
        lane: chartNote.lane,
        rect,
        judged: false
      });
    }
  }

  private createTexts() {
    this.scoreText = this.add.text(20, 20, 'SCORE: 0', {
      fontSize: '28px',
      color: '#ffffff'
    });

    this.comboText = this.add.text(20, 60, 'COMBO: 0', {
      fontSize: '28px',
      color: '#ffffff'
    });

    this.judgmentText = this.add.text(270, 700, '', {
      fontSize: '48px',
      color: '#ffffff'
    });

    this.judgmentText.setOrigin(0.5);

    this.add.text(80, 900, 'A', {
      fontSize: '32px',
      color: '#ffffff'
    });

    this.add.text(260, 900, 'S', {
      fontSize: '32px',
      color: '#ffffff'
    });

    this.add.text(440, 900, 'D', {
      fontSize: '32px',
      color: '#ffffff'
    });
  }

  private createStartMenu() {
    this.isStartMenuOpen = true;

    const overlay = this.add.rectangle(
      this.gameWidth / 2,
      this.gameHeight / 2,
      this.gameWidth,
      this.gameHeight,
      0x000000,
      0.75
    );

    overlay.setDepth(50);

    const titleText = this.add.text(
      this.gameWidth / 2,
      210,
      '音ゲーやってみよ！',
      {
        fontSize: '42px',
        color: '#ffffff',
        align: 'center'
      }
    );

    titleText.setOrigin(0.5);
    titleText.setDepth(51);

    this.highSpeedText = this.add.text(
      this.gameWidth / 2,
      320,
      '',
      {
        fontSize: '36px',
        color: '#ffffff',
        align: 'center'
      }
    );

    this.highSpeedText.setOrigin(0.5);
    this.highSpeedText.setDepth(51);

    const minusButton = this.add.rectangle(
      165,
      400,
      90,
      60,
      0x444444
    );

    minusButton.setDepth(51);
    minusButton.setInteractive({ useHandCursor: true });

    const minusText = this.add.text(165, 400, '−', {
      fontSize: '42px',
      color: '#ffffff'
    });

    minusText.setOrigin(0.5);
    minusText.setDepth(52);
    minusText.setInteractive({ useHandCursor: true });

    const plusButton = this.add.rectangle(
      375,
      400,
      90,
      60,
      0x444444
    );

    plusButton.setDepth(51);
    plusButton.setInteractive({ useHandCursor: true });

    const plusText = this.add.text(375, 400, '+', {
      fontSize: '42px',
      color: '#ffffff'
    });

    plusText.setOrigin(0.5);
    plusText.setDepth(52);
    plusText.setInteractive({ useHandCursor: true });

    const guideText = this.add.text(
      this.gameWidth / 2,
      475,
      '← / → か − / + でハイスピを変える',
      {
        fontSize: '22px',
        color: '#cccccc',
        align: 'center'
      }
    );

    guideText.setOrigin(0.5);
    guideText.setDepth(51);

    const startButton = this.add.rectangle(
      this.gameWidth / 2,
      580,
      260,
      70,
      0x666666
    );

    startButton.setDepth(51);
    startButton.setInteractive({ useHandCursor: true });

    const startText = this.add.text(
      this.gameWidth / 2,
      580,
      'やる',
      {
        fontSize: '36px',
        color: '#ffffff'
      }
    );

    startText.setOrigin(0.5);
    startText.setDepth(52);
    startText.setInteractive({ useHandCursor: true });

    const startGuideText = this.add.text(
      this.gameWidth / 2,
      655,
      'スペースキーやエンターキーを押すか『やる』をタップ',
      {
        fontSize: '18px',
        color: '#cccccc',
        align: 'center'
      }
    );

    startGuideText.setOrigin(0.5);
    startGuideText.setDepth(51);

    minusButton.on('pointerdown', () => {
      this.changeHighSpeed(-this.highSpeedStep);
    });

    minusText.on('pointerdown', () => {
      this.changeHighSpeed(-this.highSpeedStep);
    });

    plusButton.on('pointerdown', () => {
      this.changeHighSpeed(this.highSpeedStep);
    });

    plusText.on('pointerdown', () => {
      this.changeHighSpeed(this.highSpeedStep);
    });

    startButton.on('pointerdown', () => {
      this.startGame();
    });

    startText.on('pointerdown', () => {
      this.startGame();
    });

    this.menuObjects.push(
      overlay,
      titleText,
      this.highSpeedText,
      minusButton,
      minusText,
      plusButton,
      plusText,
      guideText,
      startButton,
      startText,
      startGuideText
    );

    this.updateHighSpeedText();
  }

  private startGame() {
    if (this.started) return;
    if (!this.isStartMenuOpen) return;

    this.started = true;
    this.isStartMenuOpen = false;

    this.hideStartMenu();

    this.startTime = this.time.now / 1000;
    this.music.play();
  }

  private hideStartMenu() {
    for (const object of this.menuObjects) {
      object.setVisible(false);

      const maybeInteractiveObject = object as Phaser.GameObjects.GameObject & {
        disableInteractive?: () => void;
      };

      if (maybeInteractiveObject.disableInteractive) {
        maybeInteractiveObject.disableInteractive();
      }
    }
  }

  private getSongTime() {
    return this.time.now / 1000 - this.startTime;
  }

  private getAppearTime() {
    return this.baseAppearTime / this.highSpeed;
  }

  private changeHighSpeed(amount: number) {
    if (!this.isStartMenuOpen) return;

    const nextValue = this.highSpeed + amount;

    const clampedValue = Math.max(
      this.minHighSpeed,
      Math.min(this.maxHighSpeed, nextValue)
    );

    this.highSpeed = Math.round(clampedValue * 2) / 2;

    this.updateHighSpeedText();

    console.log(`HIGH SPEED: ${this.highSpeed.toFixed(1)}`);
  }

  private updateHighSpeedText() {
    this.highSpeedText.setText(`HIGH SPEED: ${this.highSpeed.toFixed(1)}`);
  }

  private queueLaneInput(lane: number) {
    if (!this.started) return;
    if (this.finished) return;

    if (lane < 1 || lane > this.laneCount) return;

    this.inputLaneQueue.push(lane);
  }

  private processActiveTouches() {
    if (!this.started) return;
    if (this.finished) return;
    if (this.isStartMenuOpen) return;

    this.touchingLanes.clear();

    const pointers = this.input.manager.pointers;

    for (const pointer of pointers) {
      if (!pointer.isDown) continue;

      const lane =
        Math.floor(pointer.x / (this.gameWidth / this.laneCount)) + 1;

      if (lane < 1 || lane > this.laneCount) continue;

      this.touchingLanes.add(lane);
    }

    for (const lane of this.touchingLanes) {
      if (!this.previousTouchingLanes.has(lane)) {
        this.queueLaneInput(lane);
      }
    }

    this.previousTouchingLanes = new Set(this.touchingLanes);
  }

  private processQueuedInputs() {
    if (this.inputLaneQueue.length === 0) return;

    const lanes = this.inputLaneQueue.slice();
    this.inputLaneQueue = [];

    for (const lane of lanes) {
      this.judgeLane(lane);
    }
  }

  private judgeLane(lane: number) {
    if (!this.started) return;
    if (this.finished) return;

    const songTime = this.getSongTime();

    let target: NoteObject | null = null;
    let bestDiff = 999;

    for (const note of this.notes) {
      if (note.judged) continue;
      if (note.lane !== lane) continue;

      const diff = Math.abs(note.time - songTime);

      if (diff < bestDiff) {
        bestDiff = diff;
        target = note;
      }
    }

    if (!target) return;

    // スマホでも押しやすいように、少し広めの判定幅
    if (bestDiff <= 0.06) {
      this.applyJudgment(target, 'いい！！', 1000, true);
    } else if (bestDiff <= 0.12) {
      this.applyJudgment(target, 'いい', 700, true);
    } else if (bestDiff <= 0.18) {
      this.applyJudgment(target, 'まあ……', 300, true);
    }
  }

  private applyJudgment(
    note: NoteObject,
    judgment: string,
    score: number,
    addCombo: boolean
  ) {
    note.judged = true;
    note.rect.destroy();

    this.score += score;

    if (judgment === 'いい！！') {
      this.perfectCount++;
    } else if (judgment === 'いい') {
      this.greatCount++;
    } else if (judgment === 'まあ……') {
      this.goodCount++;
    }

    if (addCombo) {
      this.combo++;

      if (this.combo > this.maxCombo) {
        this.maxCombo = this.combo;
      }
    } else {
      this.combo = 0;
    }

    this.showJudgment(judgment);
    this.updateScoreText();

    console.log(judgment);
  }

  private showJudgment(text: string) {
    this.judgmentText.setText(text);

    this.tweens.killTweensOf(this.judgmentText);

    this.judgmentText.setAlpha(1);
    this.judgmentText.setScale(1.2);

    this.tweens.add({
      targets: this.judgmentText,
      alpha: 0,
      scale: 1.0,
      duration: 400,
      ease: 'Power2'
    });
  }

  private updateScoreText() {
    this.scoreText.setText(`SCORE: ${this.score}`);
    this.comboText.setText(`COMBO: ${this.combo}`);
  }

  private finishGame() {
    this.finished = true;

    if (this.music.isPlaying) {
      this.music.stop();
    }

    for (const note of this.notes) {
      if (!note.judged) {
        note.rect.destroy();
        note.judged = true;
      }
    }

    const overlay = this.add.rectangle(
      this.gameWidth / 2,
      this.gameHeight / 2,
      this.gameWidth,
      this.gameHeight,
      0x000000,
      0.85
    );

    overlay.setDepth(100);

    const resultText =
      `RESULT\n\n` +
      `SCORE: ${this.score}\n` +
      `MAX COMBO: ${this.maxCombo}\n` +
      `ハイスピ: ${this.highSpeed.toFixed(1)}\n\n` +
      `いい！！: ${this.perfectCount}\n` +
      `いい: ${this.greatCount}\n` +
      `まあ……: ${this.goodCount}\n` +
      `がんばれ: ${this.missCount}`;

    const text = this.add.text(
      this.gameWidth / 2,
      390,
      resultText,
      {
        fontSize: '36px',
        color: '#ffffff',
        align: 'center'
      }
    );

    text.setOrigin(0.5);
    text.setDepth(101);

    const retryButton = this.add.rectangle(
      this.gameWidth / 2,
      720,
      260,
      70,
      0x666666
    );

    retryButton.setDepth(101);
    retryButton.setInteractive({ useHandCursor: true });

    const retryText = this.add.text(
      this.gameWidth / 2,
      720,
      'もう一回',
      {
        fontSize: '36px',
        color: '#ffffff'
      }
    );

    retryText.setOrigin(0.5);
    retryText.setDepth(102);
    retryText.setInteractive({ useHandCursor: true });

    const retryGuideText = this.add.text(
      this.gameWidth / 2,
      790,
      'Press R or Tap RETRY',
      {
        fontSize: '22px',
        color: '#cccccc',
        align: 'center'
      }
    );

    retryGuideText.setOrigin(0.5);
    retryGuideText.setDepth(101);

    retryButton.on('pointerdown', () => {
      this.restartGame();
    });

    retryText.on('pointerdown', () => {
      this.restartGame();
    });

    this.input.keyboard?.once('keydown-R', () => {
      this.restartGame();
    });
  }

  private restartGame() {
    this.sound.stopAll();
    this.scene.restart();
  }
}