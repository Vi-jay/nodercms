const Client = require('ssh2').Client;
const fse = require("fs-extra");
const fs = require('fs');
const path = require('path');

const yaml = require("js-yaml");
const CONFIG = yaml.load(fs.readFileSync("publish-config.yaml", 'utf8'));
const archiver = require('archiver');

/***
 * 打包源码 上传指定目录
 * 连接服务器 解压指定目录
 * npm install && npm start && pm2 logs
 * 执行另一个脚本 下载下来nginx配置 修改后上传
 */
class FuckPublish {
    conn = new Client();

    path2Dir(path) {
        return path.indexOf("/", path.length) > -1 ? path + "/" : path
    }

    genSourceCode() {
        fse.emptyDirSync("./upload-temps")
        const copyDir2Temp = (dir) => fse.copySync(`./${dir}`, `./upload-temps/${dir}`);
        const files = fs.readdirSync("./");
        files.forEach((name) => {
            if (CONFIG.excludes.some((s) => name.endsWith(s))) return;
            copyDir2Temp(name);
        })
    }

    connect() {
        this.conn.connect({
            host: CONFIG.ip,
            port: 22,
            username: CONFIG.username,
            password: CONFIG.password
        });
        return new Promise(resolve => this.conn.on('ready', resolve));
    }

    connectSFTP() {
        return new Promise((resolve, reject) => this.conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp)));

    }

    async uploadSourceCode() {
        this.genSourceCode()
        const uploadZipPath = __dirname + '/upload.zip';
        const output = fs.createWriteStream(uploadZipPath);
        const archive = archiver('zip', {zlib: {level: 6}});
        archive.pipe(output);
        archive.directory("./upload-temps", "", {});
        await archive.finalize();
        const sftp = await this.connectSFTP();
        return new Promise((resolve, reject) => sftp.fastPut(path.resolve(".", "upload.zip"),
            path.posix.join(CONFIG.targetPath, "upload.zip"), err => err ? reject(err) : resolve()));
    }

    async connExec(cmd) {
        const stream = await new Promise(resolve => this.conn.exec(cmd, (err, stream) => resolve(stream)));
        stream.pipe(process.stdout);
        await new Promise(resolve => stream.on("end", resolve));
        console.log(`=========${cmd}执行完毕=========`)
    }

    async genShell() {
        return new Promise(resolve => this.conn.shell((err, stream) => {
                if (err) throw err;
                stream.on('close', () => this.conn.end()).on('data', (data) => console.log('输出：' + data));
                resolve(stream);
            })
        )
    }


    async downloadNGConf() {
        await this.connect();
        const sftp = await this.connectSFTP();
        const cfgName = `www.kacn.app.conf`;
        sftp.fastGet(`/usr/local/nginx/conf/conf.d/${cfgName}`, `./${cfgName}`, () => this.conn.end());
    }

    async runCI() {
        await this.connect();
        await this.connExec(`mkdir ${CONFIG.targetPath}`);
        await this.uploadSourceCode();
        await this.connExec(`unzip -o ${path.posix.join(CONFIG.targetPath, "upload.zip")} -d ${this.path2Dir(CONFIG.targetPath)}`);
        const shell = await this.genShell();
        shell.end(`
        cd ${CONFIG.targetPath}\n
        yarn\n
        npm stop\n
        npm start\n
        pm2 logs\n
        exit\n`);
    }

    async syncNGConf() {
        await this.connect();
        const sftp = await this.connectSFTP();
        const cfgName = `www.kacn.app.conf`;
        sftp.fastPut(`./${cfgName}`, `/usr/local/nginx/conf/conf.d/${cfgName}`, async () => {
            const shell = await this.genShell();
            shell.end(`/usr/local/nginx/sbin/nginx -s reload\n exit\n`);
        });
    }
}

new FuckPublish().runCI();
