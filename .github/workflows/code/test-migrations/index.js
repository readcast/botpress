require('bluebird-global')
const exec = require('child_process').exec
const archive = require('../../../../out/bp/core/misc/archive')
const fs = require('fs')
const rimraf = require('rimraf')
const path = require('path')
const glob = require('glob')
const semver = require('semver')
const _ = require('lodash')
const AWS = require('aws-sdk')
const chalk = require('chalk')
const core = require('@actions/core')

const start = async () => {
  const targetVersion = getMostRecentVersion()

  const Bucket = 'botpress-migrations'
  const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  })

  console.log('list obj')
  const dir = await Promise.fromCallback(cb => s3.listObjectsV2({ Bucket }, cb))
  for (const file of dir.Contents) {
    const [archiveName, version] = file.Key.split('_')

    const archiveVersion = version.replace(/.tgz|.zip/, '')
    console.log('processing', archiveName, archiveVersion)
    const buffer = await Promise.fromCallback(cb => s3.getObject({ Bucket, Key: file.Key }, cb))
    await prepareDataFolder(buffer.Body)
    console.log('mig')
    await testMigration(archiveName, archiveVersion, targetVersion, { isDown: false })
    await testMigration(archiveName, targetVersion, archiveVersion, { isDown: true })
  }
}

const prepareDataFolder = async buffer => {
  await Promise.fromCallback(cb => rimraf('./out/bp/data', cb))
  await archive.extractArchive(buffer, './out/bp')
  // await restorePostgresDump()
}

// const restorePostgresDump = async () => {
//   const dbUrl = process.env.DATABASE_URL
//   const dumpPath = path.resolve('./out/bp/data/storage/postgres.dump')

//   if (!dbUrl || !dbUrl.startsWith('postgres') || !fs.existsSync(dumpPath)) {
//     return
//   }
//   console.log('Restoring Postgres dump file...')

//   const dbName = dbUrl.substring(dbUrl.lastIndexOf('/') + 1)
//   const urlWithoutDb = dbUrl.replace(`/${dbName}`, '')

//   const res = await execute(`psql -tc "SELECT 'exists' FROM pg_database WHERE datname = '${dbName}'" ${urlWithoutDb}`)
//   if (!res.includes('exists')) {
//     await execute(`psql -c "CREATE DATABASE ${dbName}" ${urlWithoutDb}`)
//   }

//   await execute(`psql -f ${dumpPath} ${dbUrl}`)
// }

const testMigration = async (botName, startVersion, targetVersion, { isDown }) => {
  // const result = await execute(`yarn start migrate ${isDown ? 'down' : 'up'} --target ${targetVersion}`, './')
  let stdoutBuffer = ''
  await Promise.fromCallback(cb => {
    const ctx = exec(`yarn start migrate ${isDown ? 'down' : 'up'} --target ${targetVersion}`, { cwd: './' }, err =>
      cb(err)
    )
    ctx.stdout.on('data', data => (stdoutBuffer += data))
  })

  const success = stdoutBuffer.match(/Migration(s?) completed successfully/)
  const status = success ? chalk.green(`[SUCCESS]`) : chalk.red(`[FAILURE]`)
  const message = `${status} Migration ${isDown ? 'DOWN' : 'UP'} of ${botName} (${startVersion} -> ${targetVersion})`

  if (!success) {
    core.setFailed(message)
    console.log(stdoutBuffer)
  } else {
    console.log(message)
  }
}

const getMostRecentVersion = () => {
  const coreMigrations = getMigrations('./out/bp')
  const modules = fs.readdirSync('./modules')

  const moduleMigrations = _.flatMap(modules, module => getMigrations(`./modules/${module}/dist`))
  const versions = [...coreMigrations, ...moduleMigrations].map(x => x.version).sort(semver.compare)

  return _.last(versions)
}

const getMigrations = rootPath => {
  return _.orderBy(
    glob.sync('migrations/*.js', { cwd: rootPath }).map(filepath => {
      const [rawVersion, timestamp, title] = path.basename(filepath).split('-')
      return {
        filename: path.basename(filepath),
        version: semver.valid(rawVersion.replace(/_/g, '.')),
        title: (title || '').replace(/\.js$/i, ''),
        date: Number(timestamp),
        location: path.join(rootPath, filepath)
      }
    }),
    'date'
  )
}

// const execute = (cmd, cwd) => {
//   const args = require('yargs')(process.argv).argv
//   cwd = cwd || args.pgPath || __dirname

//   return Promise.fromCallback(cb => {
//     let outBuffer = ''
//     const ctx = exec(cmd, { cwd }, err => cb(err, outBuffer))
//     ctx.stdout.on('data', data => (outBuffer += data))
//   })
// }

start()