import mongoose, { Schema, Document } from 'mongoose'

export interface IDoctor extends Document {
  id: string
  openHours: {
    mon: { start: number; end: number, appointmentType: 'AV'| 'V' | 'A'}[]
    tue: { start: number; end: number, appointmentType: 'AV'| 'V' | 'A' }[]
    wed: { start: number; end: number, appointmentType: 'AV'| 'V' | 'A' }[]
    thu: { start: number; end: number, appointmentType: 'AV'| 'V' | 'A' }[]
    fri: { start: number; end: number, appointmentType: 'AV'| 'V' | 'A' }[]
    sat: { start: number; end: number, appointmentType: 'AV'| 'V' | 'A' }[]
    sun: { start: number; end: number, appointmentType: 'AV'| 'V' | 'A' }[]
  }
}

const appointmentTypeSchema: Schema = new Schema(
  {
    _id: String,
     ap: String,enum: ['AV', 'V', 'A']
  }
)

const DoctorSchema: Schema = new Schema(
  {
    _id: String,
    id: { type: String, required: true },
    openHours: {
      mon: [{ start: Number, end: Number, appointmentType: {type: String,enum: ['AV', 'V', 'A'], required:true}}],
      tue: [{ start: Number, end: Number, appointmentType: {type: String,enum: ['AV', 'V', 'A'], required:true}}],
      wed: [{ start: Number, end: Number, appointmentType: {type: String,enum: ['AV', 'V', 'A'], required:true}}],
      thu: [{ start: Number, end: Number, appointmentType: {type: String,enum: ['AV', 'V', 'A'], required:true}}],
      fri: [{ start: Number, end: Number, appointmentType: {type: String,enum: ['AV', 'V', 'A'], required:true}}],
      sat: [{ start: Number, end: Number, appointmentType: {type: String,enum: ['AV', 'V', 'A'], required:true}}],
      sun: [{ start: Number, end: Number, appointmentType: {type: String,enum: ['AV', 'V', 'A'], required:true}}],
    },
  },
  { timestamps: true, _id: false }
)



DoctorSchema.index({ id: 1 })

export default mongoose.model<IDoctor>('Doctor', DoctorSchema)
