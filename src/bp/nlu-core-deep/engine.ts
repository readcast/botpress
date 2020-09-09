import { MLToolkit, NLU } from 'botpress/sdk'
import * as sdk from 'botpress/sdk'
import crypto from 'crypto'
import _ from 'lodash'
import { Partial } from 'lodash-decorators'

import * as CacheManager from '../core/services/nlu/cache-manager'

import { Net } from './models/deepnet'

const trainDebug = DEBUG('nlu').sub('training')
interface Model {
  hash?: string
  id?: string
  languageCode?: string
  startedAt?: Date
  finishedAt?: Date
  data?: {
    input: NLU.IntentDefinition[]
    output: string
  }
  net?: Net
}
export default class Engine implements NLU.Engine {
  private modelsByLang: _.Dictionary<Model> = {}

  public static async initialize(config: NLU.Config, logger: NLU.Logger): Promise<void> {}

  public static getHealth() {
    return {
      isEnabled: true,
      validProvidersCount: 1,
      validLanguages: ['en']
    } as sdk.NLU.Health
  }

  public static getLanguages() {
    return ['en']
  }

  constructor(private botId: string, private logger: NLU.Logger) {}

  public computeModelHash(intents: NLU.IntentDefinition[], entities: NLU.EntityDefinition[], lang: string): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({ intents, entities, lang, botId: this.botId }))
      .digest('hex')
  }

  async loadModel(serialized: NLU.Model | undefined) {
    if (!serialized || !serialized.languageCode) {
      return
    }
    try {
      let model = this.modelsByLang[serialized.languageCode]
      if (!model) {
        model = {} as Model
        model.net = new Net(serialized.languageCode, model.data!.input.length)
      }
      model.data = {
        input: JSON.parse(serialized.data.input),
        output: serialized.data.output
      }
      await model.net!.load(serialized.languageCode, serialized.data.output)
      this.modelsByLang[serialized.languageCode] = model
    } catch (e) {
      console.log('ERROR LOADING MODEL : ', e)
      return undefined
    }
  }

  public hasModel(language: string, hash: string): boolean {
    if (!this.modelsByLang[language]) {
      return false
    }
    return this.modelsByLang[language].hash === hash
  }

  public hasModelForLang(language: string): boolean {
    return !!this.modelsByLang[language]
  }

  async train(
    trainSessionId: string,
    intentDefs: NLU.IntentDefinition[],
    entityDefs: NLU.EntityDefinition[],
    languageCode: string,
    options?: NLU.TrainingOptions
  ): Promise<NLU.Model | undefined> {
    if (!intentDefs.length) {
      return
    }
    trainDebug.forBot(this.botId, `Started ${languageCode} training`)
    const model: Model = this.modelsByLang[languageCode] ?? {}
    if (!model.net || _.uniqBy(model.data?.input, 'name') !== _.uniqBy(intentDefs, 'name')) {
      model.net = new Net(languageCode, intentDefs.length)
      model.data = { input: intentDefs, output: model.net.netPath }
    }
    model.id = trainSessionId

    model.startedAt = new Date()
    await model.net!.train(intentDefs, entityDefs)
    model.finishedAt = new Date()
    model.hash = this.computeModelHash(intentDefs, entityDefs, languageCode)
    this.modelsByLang[languageCode] = model
    return {
      hash: model.hash,
      languageCode: languageCode,
      startedAt: model.startedAt,
      finishedAt: model.finishedAt,
      data: {
        input: JSON.stringify(intentDefs),
        output: model.data.output
      }
    } as NLU.Model
  }

  async cancelTraining(trainSessionId: string) {
    const modelToCancel = Object.values(this.modelsByLang).find(m => m.id === trainSessionId)
    if (modelToCancel) {
      modelToCancel!.net!.cancel()
    }
  }

  async detectLanguage(sentence: string): Promise<string> {
    return 'en'
  }

  async predict(sentence: string, contexts: string[], language: string): Promise<sdk.IO.EventUnderstanding> {
    const pred = await this.modelsByLang[language].net!.predict(sentence)
    console.log(pred)
    const predictions = {} as NLU.Predictions
    for (const ctx of contexts) {
      predictions[ctx] = { confidence: 0.5, oos: 0, intents: pred[2] }
    }
    return {
      language: language,
      detectedLanguage: language,
      ms: Date.now(),
      errored: false,
      entities: [],
      includedContexts: contexts,
      predictions
    }
  }
}
