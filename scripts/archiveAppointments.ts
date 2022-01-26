import 'dotenv/config'

import mongoose from 'mongoose'

import CoreAppointment from '../src/models/CoreAppointment'

// This script updates the status of CoreAppointments Documents in MongoDB 
// It is executed periodically by a crontab 
// TODO: make it a ENV var 

export const archiveAppointments = async () => {
  await mongoose.connect(`${process.env.MONGODB_URI}`, {
    useNewUrlParser: true,
    useCreateIndex: true,
    useFindAndModify: false,
    useUnifiedTopology: true,
  })

  const hoursAgo = new Date()
  hoursAgo.setHours(hoursAgo.getHours() - 2)

  try {
    const res = await CoreAppointment.updateMany(
      { date: { $lte: hoursAgo }, status: { $ne: 'locked' } },
      { status: 'locked' }
    )
    console.log('🏛 ✅ DAILY ARCHIVE ORDERS TASK RESULTS: ', res)
  } catch (err) {
    console.log(err)
  }
  mongoose.disconnect()
}

if (require.main === module) {
  archiveAppointments()
}
