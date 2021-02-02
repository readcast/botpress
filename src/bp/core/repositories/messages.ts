import * as sdk from 'botpress/sdk'
import { inject, injectable, postConstruct } from 'inversify'

import Database from '../database'
import { TYPES } from '../types'
import LRU from 'lru-cache'
import ms from 'ms'
import { JobService } from 'core/services/job-service'

export interface MessageRepository {
  getAll(conversationId: number, limit?: number): Promise<sdk.Message[]>
  deleteAll(conversationId: number): Promise<number>
  create(
    conversationId: number,
    eventId: string,
    incomingEventId: string,
    from: string,
    payload: any
  ): Promise<sdk.Message>
  getById(messageId: number): Promise<sdk.Message | undefined>
  delete(messageId: number): Promise<boolean>
  query()
  serialize(message: Partial<sdk.Message>)
  deserialize(message: any): sdk.Message
}

@injectable()
export class KnexMessageRepository implements MessageRepository {
  private readonly TABLE_NAME = 'messages'
  private cache = new LRU<number, sdk.Message>({ max: 10000, maxAge: ms('5min') })
  private invalidateMsgCache: Function = this._localInvalidateMsgCache

  constructor(
    @inject(TYPES.Database) private database: Database,
    @inject(TYPES.JobService) private jobService: JobService
  ) {}

  @postConstruct()
  async init() {
    this.invalidateMsgCache = await this.jobService.broadcast<void>(this._localInvalidateMsgCache.bind(this))
  }

  public async getAll(conversationId: number, limit?: number): Promise<sdk.Message[]> {
    let query = this.query()
      .where({ conversationId })
      .orderBy('sentOn')

    if (limit) {
      query = query.limit(limit)
    }

    return (await query).map(x => this.deserialize(x))
  }

  public async deleteAll(conversationId: number): Promise<number> {
    const numberOfDeletedRows = await this.query()
      .where({ conversationId })
      .del()

    this.invalidateMsgCache(undefined)

    return numberOfDeletedRows
  }

  public async create(
    conversationId: number,
    eventId: string,
    incomingEventId: string,
    from: string,
    payload: any
  ): Promise<sdk.Message> {
    const row = {
      conversationId,
      eventId,
      incomingEventId,
      from,
      sentOn: new Date(),
      payload
    }

    const [id] = await this.query()
      .insert(this.serialize(row))
      .returning('id')

    const message = {
      id,
      ...row
    }
    this.cache.set(id, message)

    return message
  }

  public async getById(messageId: number): Promise<sdk.Message | undefined> {
    const cached = this.cache.get(messageId)
    if (cached) {
      return cached
    }

    const rows = await this.query()
      .select('*')
      .where({ id: messageId })

    const message = this.deserialize(rows[0])
    if (message) {
      this.cache.set(messageId, message)
    }

    return message
  }

  public async delete(messageId: number): Promise<boolean> {
    const numberOfDeletedRows = await this.query()
      .where({ id: messageId })
      .del()

    this.invalidateMsgCache(messageId)

    return numberOfDeletedRows > 0
  }

  public query() {
    return this.database.knex(this.TABLE_NAME)
  }

  public serialize(message: Partial<sdk.Message>) {
    const { conversationId, eventId, incomingEventId, from, sentOn, payload } = message
    return {
      conversationId,
      eventId,
      incomingEventId,
      from,
      sentOn: sentOn?.toISOString(),
      payload: this.database.knex.json.set(payload)
    }
  }

  public deserialize(message: any): sdk.Message {
    const { id, conversationId, eventId, incomingEventId, from, sentOn, payload } = message
    return {
      id,
      conversationId,
      eventId,
      incomingEventId,
      from,
      sentOn: new Date(sentOn),
      payload: this.database.knex.json.get(payload)
    }
  }

  private _localInvalidateMsgCache(id: number) {
    if (id) {
      this.cache.del(id)
    } else {
      this.cache.reset()
    }
  }
}