import 'dotenv/config'

import mongoose from 'mongoose'
import { MongoClient, Db } from 'mongodb'
import fs from 'fs'
import path from 'path'
import readline from 'readline'

const DB = process.env.MONGODB_URI

if (!DB) {
  console.log('Please provide a MongoDB connection string as $MONGODB_URI.')
  process.exit(1)
}

mongoose.connect(DB, { useNewUrlParser: true, useCreateIndex: true, useFindAndModify: false, useUnifiedTopology: true })

const client = new MongoClient(DB, { useUnifiedTopology: true })

client.connect(async () => {
  console.log('Connected successfully to server')

  const db = client.db()

  try {
    let migrations = fs.readdirSync(path.join(__dirname, 'migrations'))

    if (process.argv[2]) {
      console.log(`Using ${process.argv[2]} to filter ...`)
      migrations = migrations.filter(m => {
        return m.split(/([0-9]+)/)[1] === process.argv[2]
      })
    }

    if (migrations.length === 0) {
      console.log('No files found')
      cleanup()
      process.exit(0)
    }
    // sort
    migrations.sort(sortFilenameByNumber)

    console.log('The following migrations will be run in this order:')
    migrations.forEach((m, i) => console.log(`${i + 1}. - ${m}`))
    const answer = await read('\nContinue? yes/[no]: ')
    if (answer !== 'yes' && answer !== 'y') {
      cleanup()
      process.exit(1)
    }

    // run
    await run(db, migrations)
  } catch (err) {
    console.log('Unable to scan directory: ' + err)
    cleanup()
    process.exit(1)
  } finally {
    // cleanup
    cleanup()
    process.exit(0)
  }
})

// sort
// only use number before the dash (if any) to sort.
const sortFilenameByNumber = (a: string, b: string) =>
  parseInt(a.split('-')[0].replace(/\D+/g, '')) - parseInt(b.split('-')[0].replace(/\D+/g, ''))

// run
const run: (db: Db, migrations: string[]) => Promise<void> = async (db, migrations) => {
  for (const file of migrations) {
    try {
      // Execute the migration
      const migration = require(path.join(__dirname, 'migrations', file))
      try {
        console.log(`\n--------------- Processing ${file} ---------------\n`)
        await migration.migration(db)
      } catch (err) {
        console.log('Failed to execute ', file, err)
      }
    } catch (error) {
      console.log('Failed to load ', file, error)
      cleanup()
      process.exit(1)
    }
  }

  console.log(`\n\n--------------- DONE 🎉 ---------------\n`)
}

export const read = (question: string) => {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    try {
      rl.question(question, (data: any) => {
        rl.close()
        resolve(data)
      })
    } catch (err) {
      rl.close()
      return reject(err)
    }
  })
}

// cleanup
const cleanup = () => {
  client.close()
  mongoose.disconnect()
}
