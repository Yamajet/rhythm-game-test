import { Scene } from 'phaser';

export class Preloader extends Scene
{
    constructor ()
    {
        super('Preloader');
    }

    init ()
    {
        //  540 x 960 画面の中央に合わせる
        this.add.image(270, 480, 'background');

        //  読み込みバーの外枠
        this.add.rectangle(270, 480, 360, 32).setStrokeStyle(1, 0xffffff);

        //  読み込みバー本体
        const bar = this.add.rectangle(270 - 178, 480, 4, 28, 0xffffff);

        //  読み込み進行に合わせてバーを伸ばす
        this.load.on('progress', (progress: number) => {
            bar.width = 4 + (356 * progress);
        });
    }

    preload ()
    {
        //  Load the assets for the game - Replace with your own assets
        this.load.setPath('assets');

        this.load.image('logo', 'logo.png');
    }

    create ()
    {
        //  MainMenuは使わず、自作ゲーム本体へ直接移動する
        this.scene.start('Game');
    }
}