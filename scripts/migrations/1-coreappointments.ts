import { Db } from 'mongodb'
import axios from 'axios'
import { differenceInHours, parseISO } from 'date-fns'

import { read } from '../migrate'

axios.defaults.baseURL = process.env.IHUB_ADDRESS!

export const migration = async (db: Db) => {
  console.log('Setting all past events to closed')
  const token = await read('\nPlease enter a valid auth_token: ')

  const resp = await axios.get('/profile/patient/appointments', {
    headers: { Authorization: `Bearer ${token}` },
  })

  const appointments = resp.data
    .map((event: any) => {
      const hours = differenceInHours(Date.now(), parseISO(event.end))
      return { ...event, hours }
    })
    .filter((event: any) => event.hours > 12)
    .map((event: any) => {
      return { status: 'closed', id: event.id }
    })
  const ids = appointments.map((a: any) => a.id)

  console.log('The following ids will be set to closed: ', ids)

  try {
    for (const appointment of appointments) {
      const msg = await db
        .collection('coreappointments')
        .updateOne({ id: appointment.id }, { $set: { status: 'closed' } }, { upsert: true })
      console.log(msg)
    }
  } catch (err) {
    console.log(err)
  }
}
