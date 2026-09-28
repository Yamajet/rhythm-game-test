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

type BombMovePattern = 'straight' | 'diagonal' | 'wave' | 'chaos';

type BombNoteObject = {
  time: number;
  lane: number;

  container: Phaser.GameObjects.Container;
  glow: Phaser.GameObjects.Arc;
  body: Phaser.GameObjects.Rectangle;
  core: Phaser.GameObjects.Arc;
  sparkles: Phaser.GameObjects.Arc[];

  judged: boolean;

  hitX: number;
  startX: number;

  appearDuration: number;
  movePattern: BombMovePattern;
  waveSeed: number;
};

export class Game extends Phaser.Scene {
  private chart!: ChartData;
  private music!: Phaser.Sound.BaseSound;
  private explosionSound!: Phaser.Sound.BaseSound;

  private notes: NoteObject[] = [];
  private bombNotes: BombNoteObject[] = [];

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

  // HIGH SPEED 1.0 のとき、通常ノーツが2秒かけて判定ラインまで落ちる
  private baseAppearTime = 2.0;

  private highSpeed = 1.0;
  private minHighSpeed = 0.5;
  private maxHighSpeed = 8.0;
  private highSpeedStep = 0.5;

  // 爆弾ノーツ設定
  // 出現させる爆弾の最大値を指定。
  private bombNoteCount = 8;

  // 爆弾ノーツの前後何秒に通常ノーツが無い場所を探すか
  private bombSafeRange = 1.5;

  // 爆弾ノーツはハイスピードに依存せず、固定でこの秒数をかけて落ちます
  private bombAppearDuration = 5.0;

  // 爆弾ノーツをタップしてしまう判定幅
  private bombJudgeWindow = 0.18;

  // 1つの爆弾ノーツが出たら、その後この秒数は次の爆弾を出さない
  private bombInterval = 10.0;

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

    // 爆弾ノーツ用
    this.load.audio('explosion', 'audio/explosion.mp3');
    this.load.image('bombResultBg', 'images/bomb-result-bg.png');
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
    this.createBombNotes();
    this.createTexts();
    this.createStartMenu();

    this.music = this.sound.add('song');
    this.explosionSound = this.sound.add('explosion');

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
    this.bombNotes = [];
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
      this.finishGame('clear');
      return;
    }

    this.updateNormalNotes(songTime);
    this.updateBombNotes(songTime);
  }

  private updateNormalNotes(songTime: number) {
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

  private updateBombNotes(songTime: number) {
    for (const bomb of this.bombNotes) {
      if (bomb.judged) continue;

      const appearStartTime = bomb.time - bomb.appearDuration;

      if (songTime < appearStartTime) {
        bomb.container.setVisible(false);
        continue;
      }

      bomb.container.setVisible(true);

      const progress = Phaser.Math.Clamp(
        (songTime - appearStartTime) / bomb.appearDuration,
        0,
        1
      );

      const startY = -100;
      const endY = this.judgmentLineY;

      const baseY = Phaser.Math.Linear(startY, endY, progress);

      let baseX = bomb.hitX;

      if (bomb.movePattern === 'straight') {
        baseX = bomb.hitX;
      } else {
        baseX = Phaser.Math.Linear(bomb.startX, bomb.hitX, progress);
      }

      let extraX = 0;
      let extraY = 0;
      let angle = 0;
      let scale = 1;

      // chaos以外にも、少しだけ拡大縮小を加える
      if (bomb.movePattern !== 'chaos') {
        scale = 1.0 + Math.sin(progress * Math.PI * 10 + bomb.waveSeed) * 0.08;
      }

      if (bomb.movePattern === 'wave') {
        extraX = Math.sin(progress * Math.PI * 6 + bomb.waveSeed) * 35;
        angle = Math.sin(progress * Math.PI * 8 + bomb.waveSeed) * 10;
      }

      if (bomb.movePattern === 'chaos') {
        extraX =
          Math.sin(progress * Math.PI * 14 + bomb.waveSeed) * 45 +
          Math.sin(progress * Math.PI * 31 + bomb.waveSeed) * 18;

        extraY = Math.sin(progress * Math.PI * 20 + bomb.waveSeed) * 18;

        angle = Math.sin(progress * Math.PI * 24 + bomb.waveSeed) * 45;

        // chaosは既存の激しい拡大縮小をそのまま使う
        scale =
          1.0 + Math.sin(progress * Math.PI * 18 + bomb.waveSeed) * 0.25;
      }

      bomb.container.x = Phaser.Math.Clamp(
        baseX + extraX,
        20,
        this.gameWidth - 20
      );

      bomb.container.y = baseY + extraY;
      bomb.container.angle = angle;
      bomb.container.setScale(scale);

      this.updateBombVisual(bomb, progress);

      // 判定ラインを通過したあと、少し経ったら消す。
      // 爆弾は「避けるノーツ」なので、見逃してもミスにはしない。
      if (songTime - bomb.time > 0.4) {
        bomb.judged = true;
        bomb.container.destroy();
      }
    }
  }

  private updateBombVisual(bomb: BombNoteObject, progress: number) {
    const hue = (progress * 720 + bomb.waveSeed * 80) % 360;

    const mainColor = Phaser.Display.Color.HSLToColor(
      hue / 360,
      1,
      0.55
    ).color;

    const subColor = Phaser.Display.Color.HSLToColor(
      ((hue + 120) % 360) / 360,
      1,
      0.65
    ).color;

    const oppositeColor = Phaser.Display.Color.HSLToColor(
      ((hue + 180) % 360) / 360,
      1,
      0.65
    ).color;

    bomb.body.fillColor = mainColor;
    bomb.body.setStrokeStyle(3, oppositeColor);

    bomb.glow.fillColor = subColor;
    bomb.glow.alpha =
      0.18 + Math.sin(progress * Math.PI * 12 + bomb.waveSeed) * 0.08;

    bomb.core.fillColor = 0xffffff;
    bomb.core.alpha =
      0.75 + Math.sin(progress * Math.PI * 18 + bomb.waveSeed) * 0.2;

    for (let i = 0; i < bomb.sparkles.length; i++) {
      const sparkle = bomb.sparkles[i];

      const sparkleHue = (hue + i * 60 + progress * 360) % 360;
      const sparkleColor = Phaser.Display.Color.HSLToColor(
        sparkleHue / 360,
        1,
        0.7
      ).color;

      sparkle.fillColor = sparkleColor;

      const sparkleScale =
        0.7 + Math.sin(progress * Math.PI * 10 + bomb.waveSeed + i) * 0.4;

      sparkle.setScale(sparkleScale);
      sparkle.alpha =
        0.45 + Math.sin(progress * Math.PI * 8 + bomb.waveSeed + i) * 0.35;
    }

    if (bomb.movePattern === 'straight') {
      bomb.container.angle +=
        Math.sin(progress * Math.PI * 8 + bomb.waveSeed) * 0.2;
    }

    if (bomb.movePattern === 'diagonal') {
      bomb.glow.setScale(1.0 + Math.sin(progress * Math.PI * 6) * 0.08);
    }

    if (bomb.movePattern === 'wave') {
      bomb.glow.setScale(1.1 + Math.sin(progress * Math.PI * 10) * 0.15);
      bomb.core.setScale(1.0 + Math.sin(progress * Math.PI * 16) * 0.25);
    }

    if (bomb.movePattern === 'chaos') {
      bomb.glow.setScale(1.2 + Math.sin(progress * Math.PI * 22) * 0.25);
      bomb.core.setScale(1.0 + Math.sin(progress * Math.PI * 30) * 0.35);

      for (let i = 0; i < bomb.sparkles.length; i++) {
        const sparkle = bomb.sparkles[i];
        const angle = progress * Math.PI * 10 + i;
        const radius = 28 + Math.sin(progress * Math.PI * 20 + i) * 14;

        sparkle.x = Math.cos(angle) * radius;
        sparkle.y = Math.sin(angle) * radius * 0.65;
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

  private createBombObject(x: number, y: number) {
    const container = this.add.container(x, y);

    const glow = this.add.circle(0, 0, 38, 0xffffff, 0.25);
    glow.setBlendMode(Phaser.BlendModes.ADD);

    const body = this.add.rectangle(0, 0, 72, 36, 0xff3333);
    body.setStrokeStyle(3, 0xffffff);

    const core = this.add.circle(0, 0, 10, 0xffffff, 0.9);
    core.setBlendMode(Phaser.BlendModes.ADD);

    const sparkles: Phaser.GameObjects.Arc[] = [];

    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI * 2 * i) / 6;
      const sparkleX = Math.cos(angle) * 34;
      const sparkleY = Math.sin(angle) * 20;

      const sparkle = this.add.circle(sparkleX, sparkleY, 4, 0xffffff, 0.8);
      sparkle.setBlendMode(Phaser.BlendModes.ADD);

      sparkles.push(sparkle);
    }

    container.add([glow, body, core, ...sparkles]);
    container.setDepth(30);
    container.setVisible(false);

    return {
      container,
      glow,
      body,
      core,
      sparkles
    };
  }

  private createBombNotes() {
    const laneWidth = this.gameWidth / this.laneCount;

    // リトライごとに、今回出現させる爆弾数を決める
    const bombNoteCount = Phaser.Math.Between(0, this.maxBombNoteCount);

    const candidates: { time: number; lane: number }[] = [];

    // 通常ノーツの1ノーツ目の判定時刻を取得する
    const firstNormalNoteTime = this.getFirstNormalNoteTime();

    // 爆弾ノーツは bombAppearDuration 秒前から表示される。
    // そのため、爆弾ノーツの判定時刻を
    // 「通常ノーツ1個目の時刻 + bombAppearDuration」以降にすることで、
    // 通常ノーツ1個目が来るまでは爆弾を表示させない。
    const minTime = Math.max(
      firstNormalNoteTime + this.bombAppearDuration,
      this.bombAppearDuration + 0.5,
      3.0
    );

    // 終了直前すぎる位置にも置かない。
    const maxTime = this.chart.endTime - 3.0;

    if (maxTime <= minTime) {
      console.log('爆弾ノーツ候補がありません。曲が短すぎる可能性があります。');
      return;
    }

    // 0.5秒刻みで、安全な着弾候補を探す。
    for (let time = minTime; time <= maxTime; time += 0.5) {
      for (let lane = 1; lane <= this.laneCount; lane++) {
        if (this.isSafeBombPosition(time, lane)) {
          candidates.push({ time, lane });
        }
      }
    }

    if (candidates.length === 0) {
      console.log('爆弾ノーツ候補が見つかりませんでした。');
      return;
    }

    Phaser.Utils.Array.Shuffle(candidates);

    const selected: { time: number; lane: number }[] = [];

    for (const candidate of candidates) {
      if (selected.length >= bombNoteCount) break;

      // 1つの爆弾ノーツが出たら、その前後10秒には別の爆弾を出さない。
      // 「その後10秒間は出現させない」という目的ですが、
      // ランダム抽出時の安定性を考えて、前後どちらにも10秒空けます。
      const tooCloseToOtherBomb = selected.some((bomb) => {
        return Math.abs(bomb.time - candidate.time) < this.bombInterval;
      });

      if (tooCloseToOtherBomb) continue;

      const randomizedCandidate = {
        time: candidate.time + Phaser.Math.FloatBetween(-0.2, 0.2),
        lane: candidate.lane
      };
      
      selected.push(randomizedCandidate);
    }

    for (const bombData of selected) {
      const hitX = (bombData.lane - 1) * laneWidth + laneWidth / 2;

      const movePattern = this.chooseBombMovePattern();

      let startX = hitX;

      if (
        movePattern === 'diagonal' ||
        movePattern === 'wave' ||
        movePattern === 'chaos'
      ) {
        const direction = Phaser.Math.Between(0, 1) === 0 ? -1 : 1;

        startX = hitX + direction * Phaser.Math.Between(90, 160);
        startX = Phaser.Math.Clamp(startX, 40, this.gameWidth - 40);
      }

      const bombObject = this.createBombObject(startX, -100);

      this.bombNotes.push({
        time: bombData.time,
        lane: bombData.lane,

        container: bombObject.container,
        glow: bombObject.glow,
        body: bombObject.body,
        core: bombObject.core,
        sparkles: bombObject.sparkles,

        judged: false,

        hitX,
        startX,

        appearDuration: this.bombAppearDuration,
        movePattern,
        waveSeed: Phaser.Math.FloatBetween(0, Math.PI * 2)
      });

      console.log(
        `爆弾ノーツ生成: time=${bombData.time.toFixed(2)}, lane=${bombData.lane}, pattern=${movePattern}`
      );
    }
  }

  private getFirstNormalNoteTime() {
    if (this.notes.length === 0) {
      return 0;
    }
  
    let firstTime = 999999;
  
    for (const note of this.notes) {
      if (note.time < firstTime) {
        firstTime = note.time;
      }
    }
  
    return firstTime;
  }

  private chooseBombMovePattern(): BombMovePattern {
    const roll = Phaser.Math.Between(1, 100);

    if (roll <= 75) {
      return 'straight';
    }

    if (roll <= 90) {
      return 'diagonal';
    }

    if (roll <= 98) {
      return 'wave';
    }

    return 'chaos';
  }

  private isSafeBombPosition(time: number, lane: number) {
    for (const note of this.notes) {
      if (note.lane !== lane) continue;

      const diff = Math.abs(note.time - time);

      if (diff < this.bombSafeRange) {
        return false;
      }
    }

    return true;
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
      if (this.finished) break;
      this.judgeLane(lane);
    }
  }

  private judgeLane(lane: number) {
    if (!this.started) return;
    if (this.finished) return;

    // 爆弾ノーツが判定範囲内にある場合は、
    // 通常ノーツより先に爆弾を処理する。
    if (this.judgeBombLane(lane)) {
      return;
    }

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

  private judgeBombLane(lane: number) {
    const songTime = this.getSongTime();

    let target: BombNoteObject | null = null;
    let bestDiff = 999;

    for (const bomb of this.bombNotes) {
      if (bomb.judged) continue;
      if (bomb.lane !== lane) continue;

      const diff = Math.abs(bomb.time - songTime);

      if (diff < bestDiff) {
        bestDiff = diff;
        target = bomb;
      }
    }

    if (!target) return false;

    if (bestDiff <= this.bombJudgeWindow) {
      this.triggerBombExplosion(target);
      return true;
    }

    return false;
  }

  private triggerBombExplosion(bomb: BombNoteObject) {
    if (bomb.judged) return;

    bomb.judged = true;

    const explosionX = bomb.container.x;
    const explosionY = bomb.container.y;

    bomb.container.destroy();

    const explosion = this.add.circle(
      explosionX,
      explosionY,
      30,
      0xff3300,
      0.9
    );

    explosion.setDepth(150);

    const ring = this.add.circle(
      explosionX,
      explosionY,
      45,
      0xffff00,
      0.5
    );

    ring.setDepth(149);

    this.tweens.add({
      targets: explosion,
      scale: 5,
      alpha: 0,
      duration: 500,
      ease: 'Power2',
      onComplete: () => {
        explosion.destroy();
      }
    });

    this.tweens.add({
      targets: ring,
      scale: 6,
      alpha: 0,
      duration: 550,
      ease: 'Power2',
      onComplete: () => {
        ring.destroy();
      }
    });

    this.explosionSound.play({
      volume: 0.7
    });
    
    this.showJudgment('爆弾だ！！');

    // 第1段階では音は鳴らさず、爆発エフェクトと同時に終了画面へ移動する。
    this.finishGame('bomb');
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

  private finishGame(reason: 'clear' | 'bomb' = 'clear') {
    if (this.finished) return;

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

    for (const bomb of this.bombNotes) {
      if (!bomb.judged) {
        bomb.container.destroy();
        bomb.judged = true;
      }
    }

if (reason === 'bomb') {
  const bombBg = this.add.image(
    this.gameWidth / 2,
    this.gameHeight / 2,
    'bombResultBg'
  );

  bombBg.setDisplaySize(this.gameWidth, this.gameHeight);
  bombBg.setDepth(99);
}

const overlayAlpha = reason === 'bomb' ? 0.45 : 0.85;

const overlay = this.add.rectangle(
  this.gameWidth / 2,
  this.gameHeight / 2,
  this.gameWidth,
  this.gameHeight,
  0x000000,
  overlayAlpha
);

overlay.setDepth(100);

    const resultTitle = reason === 'bomb' ? '爆発した！！' : 'RESULT';

    const resultText =
      `${resultTitle}\n\n` +
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

    if (reason === 'bomb') {
      const bombMessage = this.add.text(
        this.gameWidth / 2,
        610,
        '爆弾にさわると危ないよ',
        {
          fontSize: '22px',
          color: '#ffcccc',
          align: 'center'
        }
      );

      bombMessage.setOrigin(0.5);
      bombMessage.setDepth(101);
    }

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
      'Rキーを押すか『もう一回』をタップ',
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