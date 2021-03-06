/**
 * @module jsonapi-vuex
 */
import Vue from 'vue'
import get from 'lodash.get'
import isEqual from 'lodash.isequal'
import merge from 'lodash.merge'
// https://github.com/dchester/jsonpath/issues/89
import jp from 'jsonpath/jsonpath.min'

/**
 * Custom exception for returning record errors
 * @memberof module:jsonapi-vuex._internal
 */
class RecordError extends Error {
  constructor(message, value) {
    super(message)
    this.value = value
  }
}

const STATUS_LOAD = 'LOADING'
const STATUS_SUCCESS = 'SUCCESS'
const STATUS_ERROR = 'ERROR'

/**
 * @namespace Configuration
 * @property {string} jvtag='_jv' - key to store jsonapi-vuex-related data in when destructuring (default: '_jv')
 * @property {boolean} followRelationshipsData=true - Follow relationships 'data' entries (from store)
 * @property {boolean} preserveJSON=false - Preserve API response json in return data
 * @property {integer} actionStatusCleanAge=600 - Age of action status records to clean (in seconds - 0 disables)
 * @property {boolean} mergeRecords=false - Merge or overwrite store records
 * @property {boolean} clearOnUpdate=false - Delete old records not contained in an update (on a per-type basis).
 * @property {boolean} cleanPatch=false - Always run 'cleanPatch' method when patching
 * @property {string[]} cleanPatchProps='[]' - If cleanPatch is enabled, which _jv props (links, meta, rels) should be kept?
 * @property {boolean} recurseRelationships=false - Allow relationships to be recursive?
 */
let jvConfig = {
  jvtag: '_jv',
  followRelationshipsData: true,
  preserveJson: false,
  actionStatusCleanAge: 600,
  mergeRecords: false,
  clearOnUpdate: false,
  cleanPatch: false,
  cleanPatchProps: [],
  recurseRelationships: false,
}

let jvtag

/**
 * Shorthand for the 'safe' `hasOwnProperty` as described here:
 * [eslint: no-prototype-builtins](https://eslint.org/docs/rules/no-prototype-builtins])
 * @memberof module:jsonapi-vuex._internal
 */
const hasProperty = (obj, prop) => {
  return Object.prototype.hasOwnProperty.call(obj, prop)
}

// Global sequence counter for unique action ids
let actionSequenceCounter = 0

/**
 * @namespace
 * @memberof module:jsonapi-vuex.jsonapiModule
 */
const mutations = () => {
  return {
    /**
     * Delete a record from the store.
     * @memberof module:jsonapi-vuex.jsonapiModule.mutations
     * @param {object} state - The Vuex state object
     * @param {(string|object)} record - The record to be deleted
     */
    deleteRecord: (state, record) => {
      const [type, id] = getTypeId(record)
      if (!type || !id) {
        throw new RecordError('deleteRecord: Missing type or id', record)
      }
      Vue.delete(state[type], id)
    },
    /**
     * Add record(s) to the store, according to `mergeRecords` config option
     * @memberof module:jsonapi-vuex.jsonapiModule.mutations
     * @param {object} state - The Vuex state object
     * @param {object} records - The record(s) to be added
     */
    addRecords: (state, records) => {
      updateRecords(state, records)
    },
    /**
     * Replace (or add) record(s) to the store
     * @memberof module:jsonapi-vuex.jsonapiModule.mutations
     * @param {object} state - The Vuex state object
     * @param {object} records - The record(s) to be replaced
     */
    replaceRecords: (state, records) => {
      updateRecords(state, records, false)
    },
    /**
     * Merge (or add) records to the store
     * @memberof module:jsonapi-vuex.jsonapiModule.mutations
     * @param {object} state - The Vuex state object
     * @param {object} records - The record(s) to be merged
     */
    mergeRecords: (state, records) => {
      updateRecords(state, records, true)
    },
    /**
     * Delete all records from the store for a given type
     * @memberof module:jsonapi-vuex.jsonapiModule.mutations
     * @param {object} state - The Vuex state object
     * @param {object} records - A record with type set.
     */
    clearRecords: (state, records) => {
      const newRecords = normToStore(records)
      for (let [type, item] of Object.entries(newRecords)) {
        const storeRecords = get(state, [type], {})
        for (let id of Object.keys(storeRecords)) {
          if (!hasProperty(item, id)) {
            Vue.delete(state[type], id)
          }
        }
      }
    },
    /**
     * Record the status id of an action in the store
     * @memberof module:jsonapi-vuex.jsonapiModule.mutations
     * @param {object} state - The Vuex state object
     * @param {object} obj
     * @param {integer} obj.id - The action id to set
     * @param {constant} obj.status - The action status to set
     */
    setStatus: (state, { id, status }) => {
      Vue.set(state[jvtag], id, { status: status, time: Date.now() })
    },
    /**
     * Delete the status id of an action from the store
     * @memberof module:jsonapi-vuex.jsonapiModule.mutations
     * @param {object} state - The Vuex state object
     * @param {integer} id - The action id to delete
     */
    deleteStatus: (state, id) => {
      if (hasProperty(state[jvtag], id)) {
        Vue.delete(state[jvtag], id)
      }
    },
  }
}

/**
 * Vuex actions, used via `this.$store.dispatch`, e.g.:
 * `this.$store.dispatch('jv/get', <args>)`
 *
 * `args` can be either a string or an object representing the item(s) required,
 * or it can be an array of string/object and an optional axios config object.
 * @namespace
 * @memberof module:jsonapi-vuex.jsonapiModule
 * @param {axios} api - an axios api instance
 */
const actions = (api) => {
  return {
    /**
     * Get items from the API
     *
     * @async
     * @memberof module:jsonapi-vuex.jsonapiModule.actions
     * @param {object} context - Vuex context object
     * @param {(string|object|array)} args - See {@link module:jsonapi-vuex.jsonapiModule.actions} for a summary of args
     * @param {string}  - A URL path to an item - e.g. `endpoint/1`
     * @param {object}  - A restructured object  - e.g. `{ _jv: { type: "endpoint", id: "1" } }`
     * @param {array}  - A 2-element array, consisting of a string/object and an optional axios config object
     * @return {object} Restructured representation of the requested item(s)
     */
    get: (context, args) => {
      const [data, config] = unpackArgs(args)
      const path = getURL(data)
      const apiConf = { method: 'get', url: path }
      // https://github.com/axios/axios/issues/362
      config['data'] = config['data'] || {}
      merge(apiConf, config)
      const actionId = actionSequence(context)
      context.commit('setStatus', { id: actionId, status: STATUS_LOAD })
      let action = api(apiConf)
        .then((results) => {
          processIncludedRecords(context, results)

          let resData = jsonapiToNorm(results.data.data)
          context.commit('addRecords', resData)
          if (jvConfig.clearOnUpdate) {
            context.commit('clearRecords', resData)
          }
          resData = checkAndFollowRelationships(
            context.state,
            context.getters,
            resData
          )
          resData = preserveJSON(resData, results.data)
          context.commit('setStatus', {
            id: actionId,
            status: STATUS_SUCCESS,
          })
          return resData
        })
        .catch((error) => {
          context.commit('setStatus', { id: actionId, status: STATUS_ERROR })
          throw error
        })
      action[jvtag + 'Id'] = actionId
      return action
    },
    /**
     * Get related items from the API
     *
     * @async
     * @memberof module:jsonapi-vuex.jsonapiModule.actions
     * @param {object} context - Vuex context object
     * @param {(string|object|array)} args - See {@link module:jsonapi-vuex.jsonapiModule.actions} for a summary of args
     * @param {string}  - A URL path to an item - e.g. `endpoint/1`
     * @param {object}  - A restructured object  - e.g. `{ _jv: { type: "endpoint", id: "1" } }`
     * @param {array}  - A 2-element array, consisting of a string/object and an optional axios config object
     * @return {object} Restructured representation of the requested item(s)
     */
    getRelated: async (context, args) => {
      const data = unpackArgs(args)[0]
      let [type, id, relName] = getTypeId(data)
      if (!type || !id) {
        throw 'No type/id specified'
      }
      const actionId = actionSequence(context)
      context.commit('setStatus', { id: actionId, status: STATUS_LOAD })

      let rels
      if (
        typeof data === 'object' &&
        hasProperty(data[jvtag], 'relationships')
      ) {
        rels = data[jvtag]['relationships']
      } else {
        try {
          let record = await context.dispatch('get', args)

          rels = get(record, [jvtag, 'relationships'], {})
          if (relName && hasProperty(rels, relName)) {
            // Only process requested relname
            rels = { [relName]: rels[relName] }
          }
        } catch (error) {
          // Log and re-throw if 'get' action fails
          context.commit('setStatus', { id: actionId, status: STATUS_ERROR })
          throw error
        }
      }

      // We can't pass multiple/non-promise vars in a promise chain,
      // so must define such vars in a higher scope
      let relNames = []
      let relPromises = []

      // Iterate over all records in rels
      for (let [relName, relItems] of Object.entries(rels)) {
        let relData
        // relationships value might be empty if user-constructed
        // so fetch relationships resource linkage for these
        if (!relItems) {
          try {
            const resLink = await api.get(
              `${type}/${id}/relationships/${relName}`
            )
            relItems = resLink.data
          } catch (error) {
            throw `No such relationship: ${relName}`
          }
        }
        // Extract relationships from 'data' (type/id)
        // empty to-one rels (null) are special-cased
        if (hasProperty(relItems, 'data') && relItems['data'] !== null) {
          relData = relItems['data']
          if (!Array.isArray(relData)) {
            // Treat as if always an array
            relData = [relData]
          }
          // Or from 'links/related'
        } else if (hasProperty(relItems, 'links')) {
          relData = relItems['links']['related']
          if (!(typeof relData === 'string')) {
            relData = relData['href']
          }
          relData = [relData]
        }
        if (relData) {
          for (let entry of relData) {
            // Rewrite 'data' objects to normalised form
            if (!(typeof entry === 'string')) {
              entry = { [jvtag]: entry }
            }
            relNames.push(relName)
            relPromises.push(context.dispatch('get', entry))
          }
        } else {
          // Empty to-one rels should have a relName but no data
          relNames.push(relName)
          // prettier-ignore
          relPromises.push(new Promise((resolve) => { resolve({}) }))
        }
      }
      // 'Merge' all promise resolution/rejection
      let action = Promise.all(relPromises)
        .then((results) => {
          let related = {}
          results.forEach((result, i) => {
            // Get the relName from the same array position as the result item
            let relName = relNames[i]
            let normItem = { [relName]: {} }
            if (hasProperty(result, jvtag)) {
              normItem[relName][result[jvtag]['type']] = {
                [result[jvtag]['id']]: result,
              }
            }
            merge(related, normItem)
          })
          context.commit('setStatus', {
            id: actionId,
            status: STATUS_SUCCESS,
          })
          return related
        })
        .catch((error) => {
          context.commit('setStatus', { id: actionId, status: STATUS_ERROR })
          throw error
        })
      action[jvtag + 'Id'] = actionId
      return action
    },
    /**
     * Post an item to the API
     *
     * @async
     * @memberof module:jsonapi-vuex.jsonapiModule.actions
     * @param {object} context - Vuex context object
     * @param {(object|array)} args - See {@link module:jsonapi-vuex.jsonapiModule.actions} for a summary of args
     * @param {object}  - A restructured object  - e.g. `{ _jv: { type: "endpoint", id: "1" } }`
     * @param {array}  - A 2-element array, consisting of a string/object and an optional axios config object
     * @return {object} Restructured representation of the posted item
     */
    post: (context, args) => {
      let [data, config] = unpackArgs(args)
      const path = getURL(data, true)
      const apiConf = { method: 'post', url: path, data: normToJsonapi(data) }
      merge(apiConf, config)
      const actionId = actionSequence(context)
      context.commit('setStatus', { id: actionId, status: STATUS_LOAD })
      let action = api(apiConf)
        .then((results) => {
          processIncludedRecords(context, results)

          // If the server handed back data, store it (to get id)
          // spec says 201, but some servers (wrongly) return 200
          if (results.status === 200 || results.status === 201) {
            data = jsonapiToNorm(results.data.data)
          }
          context.commit('addRecords', data)
          context.commit('setStatus', {
            id: actionId,
            status: STATUS_SUCCESS,
          })
          return preserveJSON(context.getters.get(data), results.data)
        })
        .catch((error) => {
          context.commit('setStatus', { id: actionId, status: STATUS_ERROR })
          throw error
        })
      action[jvtag + 'Id'] = actionId
      return action
    },
    /**
     * Patch an item in the API
     *
     * @async
     * @memberof module:jsonapi-vuex.jsonapiModule.actions
     * @param {object} context - Vuex context object
     * @param {(object|array)} args - See {@link module:jsonapi-vuex.jsonapiModule.actions} for a summary of args
     * @param {object}  - A restructured object  - e.g. `{ _jv: { type: "endpoint", id: "1" } }`
     * @param {array}  - A 2-element array, consisting of a string/object and an optional axios config object
     * @return {object} Restructured representation of the patched item
     */
    patch: (context, args) => {
      let [data, config] = unpackArgs(args)
      if (jvConfig.cleanPatch) {
        data = cleanPatch(data, context.state, jvConfig.cleanPatchProps)
      }
      const path = getURL(data)
      const actionId = actionSequence(context)
      const apiConf = { method: 'patch', url: path, data: normToJsonapi(data) }
      merge(apiConf, config)
      context.commit('setStatus', { id: actionId, status: STATUS_LOAD })
      let action = api(apiConf)
        .then((results) => {
          // If the server handed back data, store it
          if (results.status === 200 && hasProperty(results.data, 'data')) {
            // Full response
            context.commit('deleteRecord', data)
            data = jsonapiToNorm(results.data.data)
            context.commit('addRecords', data)
          } else {
            // 200 (meta-only), or 204 (no resource) response
            // Update the store record from the patch
            context.commit('mergeRecords', data)
          }

          // NOTE: We deliberately process included records after any `deleteRecord` mutations
          // to avoid deleting any included records that we just added.
          processIncludedRecords(context, results)

          context.commit('setStatus', {
            id: actionId,
            status: STATUS_SUCCESS,
          })
          return preserveJSON(context.getters.get(data), results.data)
        })
        .catch((error) => {
          context.commit('setStatus', { id: actionId, status: STATUS_ERROR })
          throw error
        })
      action[jvtag + 'Id'] = actionId
      return action
    },
    /**
     * Delete an item from the API
     *
     * @async
     * @memberof module:jsonapi-vuex.jsonapiModule.actions
     * @param {object} context - Vuex context object
     * @param {(string|object|array)} args - See {@link module:jsonapi-vuex.jsonapiModule.actions} for a summary of args
     * @param {string}  - A URL path to an item - e.g. `endpoint/1`
     * @param {object}  - A restructured object  - e.g. `{ _jv: { type: "endpoint", id: "1" } }`
     * @param {array}  - A 2-element array, consisting of a string/object and an optional axios config object
     * @return {object} Restructured representation of the deleted item
     */
    delete: (context, args) => {
      const [data, config] = unpackArgs(args)
      const path = getURL(data)
      const apiConf = { method: 'delete', url: path }
      merge(apiConf, config)
      const actionId = actionSequence(context)
      context.commit('setStatus', { id: actionId, status: STATUS_LOAD })
      let action = api(apiConf)
        .then((results) => {
          processIncludedRecords(context, results)

          context.commit('deleteRecord', data)
          context.commit('setStatus', {
            id: actionId,
            status: STATUS_SUCCESS,
          })
          if (results.data) {
            return preserveJSON(jsonapiToNorm(results.data.data), results.data)
          } else {
            return data
          }
        })
        .catch((error) => {
          context.commit('setStatus', { id: actionId, status: STATUS_ERROR })
          throw error
        })
      action[jvtag + 'Id'] = actionId
      return action
    },
    /**
     * Get items from the API without updating the Vuex store
     *
     * @see module:jsonapi-vuex.jsonapiModule.actions.get
     * @async
     * @memberof module:jsonapi-vuex.jsonapiModule.actions
     * @param {object} context - Vuex context object
     * @param {(string|object|array)} args - See {@link module:jsonapi-vuex.jsonapiModule.actions} for a summary of args
     * @param {string}  - A URL path to an item - e.g. `endpoint/1`
     * @param {object}  - A restructured object  - e.g. `{ _jv: { type: "endpoint", id: "1" } }`
     * @param {array}  - A 2-element array, consisting of a string/object and an optional axios config object
     * @return {object} Restructured representation of the posted item
     */
    search: (context, args) => {
      // Create a 'noop' context.commit to avoid store modifications
      const nocontext = {
        commit: () => {},
        dispatch: context.dispatch,
        getters: context.getters,
      }
      // Use a new actions 'instance' instead of 'dispatch' to allow context override
      return actions(api).get(nocontext, args)
    },
    /**
     * Alias for {@link module:jsonapi-vuex.jsonapiModule.actions.get}
     * @async
     * @memberof module:jsonapi-vuex.jsonapiModule.actions
     */
    get fetch() {
      return this.get
    },
    /**
     * Alias for {@link module:jsonapi-vuex.jsonapiModule.actions.post}
     * @async
     * @memberof module:jsonapi-vuex.jsonapiModule.actions
     */
    get create() {
      return this.post
    },
    /**
     * Alias for {@link module:jsonapi-vuex.jsonapiModule.actions.patch}
     * @async
     * @memberof module:jsonapi-vuex.jsonapiModule.actions
     */
    get update() {
      return this.patch
    },
  }
}

/**
 * Vuex getters, used via `this.$store.getters`, e.g.:
 * `this.$store.getters['jv/get'](<args>)
 *
 * @namespace
 * @memberof module:jsonapi-vuex.jsonapiModule
 */
const getters = () => {
  return {
    /**
     * Get record(s) from the store
     *
     * @memberof module:jsonapi-vuex.jsonapiModule.getters
     * @param {(string|object)} data
     * @param {string}  - A URL path to an item - e.g. `endpoint/1`
     * @param {object}  - A restructured object  - e.g. `{ _jv: { type: "endpoint", id: "1" } }`
     * @param {string} jsonpath - a JSONPath string to filter the record(s) which are being retrieved. See [JSONPath Syntax](https://github.com/dchester/jsonpath#jsonpath-syntax)
     * @return {object} Restructured representation of the record(s)
     */
    get: (state, getters) => (data, jsonpath, seen) => {
      let result
      if (!data) {
        // No data arg - return whole state object
        result = state
      } else {
        const [type, id] = getTypeId(data)

        if (hasProperty(state, type)) {
          if (id) {
            if (hasProperty(state[type], id)) {
              // single item
              result = state[type][id]
            } else {
              // No item of that type
              return {}
            }
          } else {
            // whole collection, indexed by id
            result = state[type]
          }
          result = checkAndFollowRelationships(state, getters, result, seen)
        } else {
          // no records for that type in state
          return {}
        }
      }

      // Filter by jsonpath
      if (jsonpath) {
        const filtered = jp.query(result, jsonpath)
        if (Array.isArray(filtered)) {
          result = {}
          for (let item of filtered) {
            result[item[jvtag]['id']] = item
          }
        }
      }
      return result
    },
    /**
     * Get the related record(s) of a record from the store
     *
     * @memberof module:jsonapi-vuex.jsonapiModule.getters
     * @param {(string|object)} data
     * @param {string}  - A URL path to an item - e.g. `endpoint/1`
     * @param {object}  - A restructured object  - e.g. `{ _jv: { type: "endpoint", id: "1" } }`
     * @return {object} Restructured representation of the record(s)
     */
    getRelated: (state, getters) => (data, seen) => {
      const [type, id] = getTypeId(data)
      if (!type || !id) {
        throw 'No type/id specified'
      }
      let parent = get(state, [type, id])
      if (parent) {
        return getRelationships(getters, parent, seen)
      }
      return {}
    },
    /**
     * Get the status of an action
     *
     * @memberof module:jsonapi-vuex.jsonapiModule.getters
     * @param {integer} id - A status action id
     * @return {string} A string representing the state of the action (LOADING|SUCCESS|ERROR)
     */
    status: (state) => (id) => {
      // If id is an object (promise), extract id
      if (typeof id === 'object') {
        id = id[jvtag + 'Id']
      }
      if (hasProperty(state[jvtag], id)) {
        return state[jvtag][id]['status']
      }
    },
  }
}

/**
 * jsonapi-vuex store module
 * @namespace
 * @memberof module:jsonapi-vuex
 * @param {axios} api - an axios instance
 * @param {object} [conf={}] - jsonapi-vuex configuation
 * @return {object} A Vuex store object
 */
const jsonapiModule = (api, conf = {}) => {
  Object.assign(jvConfig, conf)
  jvtag = jvConfig['jvtag']
  let state = { [jvtag]: {} }

  return {
    namespaced: true,

    state: state,

    mutations: mutations(),
    actions: actions(api),
    getters: getters(),
  }
}

// Helper functions
/**
 * Documentation for internal functions etc.
 * These are not available when the module is imported,
 * and are documented for module developers only.
 * @namespace _internal
 * @memberof module:jsonapi-vuex
 */

/**
 * Make a copy of a restructured object, adding (js) getters for its relationships
 * That call the (vuex) get getter to fecth that record from the store
 *
 * Already seen objects are tracked using the 'seen' param to avoid loops.
 *
 * @memberof module:jsonapi-vuex._internal
 * @param {object} getters - Vuex getters object
 * @param {object} parent - The object whose relationships should be fetched
 * @param {array} seen - Internal recursion state tracking
 * @returns {object} A copy of the object with getter relationships added
 */
const getRelationships = (getters, parent, seen = []) => {
  let relationships = get(parent, [jvtag, 'relationships'], {})
  let relationshipsData = {}
  for (let relName of Object.keys(relationships)) {
    let relations = get(relationships, [relName, 'data'])
    relationshipsData[relName] = {}
    if (relations) {
      let isItem = !Array.isArray(relations)
      let relationsData = {}

      for (let relation of isItem ? Array.of(relations) : relations) {
        let relType = relation['type']
        let relId = relation['id']

        if (!hasProperty(relationsData, relId)) {
          Object.defineProperty(relationsData, relId, {
            get() {
              let current = [relName, relType, relId]
              // Stop if seen contains an array which matches 'current'
              if (
                !jvConfig.recurseRelationships &&
                seen.some((a) => a.every((v, i) => v === current[i]))
              ) {
                return { [jvtag]: { type: relType, id: relId } }
              } else {
                // prettier-ignore
                return getters.get(
                    `${relType}/${relId}`,
                    undefined,
                    [...seen, [relName, relType, relId]]
                  )
              }
            },
            enumerable: true,
          })
        }
      }
      if (isItem) {
        Object.defineProperty(
          relationshipsData,
          relName,
          Object.getOwnPropertyDescriptor(
            relationsData,
            Object.keys(relationsData)[0]
          )
        )
      } else {
        Object.defineProperties(
          relationshipsData[relName],
          Object.getOwnPropertyDescriptors(relationsData)
        )
      }
    }
  }
  return relationshipsData
}

/**
 * Deep copy a normalised object, then re-add helper nethods
 * @memberof module:jsonapi-vuex.utils
 * @param {object} obj - An object to be deep copied
 * @return {object} A deep copied object, with Helper functions added
 */
const deepCopy = (obj) => {
  const copyObj = _copy(obj)
  if (Object.entries(copyObj).length) {
    return addJvHelpers(copyObj)
  }
  return obj
}

/**
 * @memberof module:jsonapi-vuex._internal
 * @param {object} data - An object to be deep copied
 * @return {object} A deep copied object
 */
const _copy = (data) => {
  // Recursive object copying function (for 'simple' objects)
  let out = Array.isArray(data) ? [] : {}
  for (let key in data) {
    // null is typeof 'object'
    if (typeof data[key] === 'object' && data[key] !== null) {
      out[key] = _copy(data[key])
    } else {
      out[key] = data[key]
    }
  }
  return out
}

/**
 * A function that cleans up a patch object, so that it doesn't introeuce unexpected chanegs when sent to the API
 * It removes any attributes which are unchanged from the store, to minimise accidental reversions.
 * It also strips out any of links, relationships and meta from `_jv` - See {@link module:jsonapi-vuex~Configuration|Configuration}
 * @memberof module:jsonapi-vuex.utils
 * @param {object} patch - A restructured object to be cleaned
 * @param {object} state={} - Vuex state object (for patch comparison)
 * @param {array} jvProps='[]' - _jv Properties to be kept
 * @return {object} A cleaned copy of the patch object
 */
const cleanPatch = (patch, state = {}, jvProps = []) => {
  // Add helper properties (use a copy to prevent side-effects)
  const modPatch = deepCopy(patch)
  const attrs = get(modPatch, [jvtag, 'attrs'])
  const clean = { [jvtag]: {} }
  // Only try to clean the patch if it exists in the store
  const stateRecord = get(state, [
    modPatch[jvtag]['type'],
    modPatch[jvtag]['id'],
  ])
  if (stateRecord) {
    for (let [k, v] of Object.entries(attrs)) {
      if (!hasProperty(stateRecord, k) || !isEqual(stateRecord[k], v)) {
        clean[k] = v
      }
    }
  } else {
    Object.assign(clean, attrs)
  }

  // Add _jv data, as required
  clean[jvtag]['type'] = patch[jvtag]['type']
  clean[jvtag]['id'] = patch[jvtag]['id']
  for (let prop of jvProps) {
    let propVal = get(patch, [jvtag, prop])
    if (propVal) {
      clean[jvtag][prop] = propVal
    }
  }

  return clean
}

/**
 * A single function to encapsulate the different merge approaches of the record mutations.
 * See {@link module:jsonapi-vuex.jsonapiModule.mutations} to see the mutations that use this function.
 *
 * @memberof module:jsonapi-vuex._internal
 * @param {object} state - Vuex state object
 * @param {object} records - Restructured records to be updated
 * @param {boolean} merging - Whether or not to merge or overwrite records
 */
const updateRecords = (state, records, merging = jvConfig.mergeRecords) => {
  const storeRecords = normToStore(records)
  for (let [type, item] of Object.entries(storeRecords)) {
    if (!hasProperty(state, type)) {
      Vue.set(state, type, {})
      // If there's no type, then there are no existing records to merge
      merging = false
    }
    for (let [id, data] of Object.entries(item)) {
      if (merging) {
        const oldRecord = get(state, [type, id])
        if (oldRecord) {
          data = merge(oldRecord, data)
        }
      }
      Vue.set(state[type], id, data)
    }
  }
}

/**
 * Helper methods added to `_jv` by {@link module:jsonapi-vuex.utils.addJvHelpers}
 * @namespace helpers
 * @memberof module:jsonapi-vuex.jsonapiModule
 */

/**
 * Add helper functions and getters to a restructured object
 * @memberof module:jsonapi-vuex.utils
 * @param {object} obj - An object to assign helpers to
 * @return {object} A copy of the object with added helper functions/getters
 */
const addJvHelpers = (obj) => {
  if (
    obj[jvtag] &&
    !hasProperty(obj[jvtag], 'isRel') &&
    !hasProperty(obj[jvtag], 'isAttr')
  ) {
    Object.assign(obj[jvtag], {
      /**
       * @memberof module:jsonapi-vuex.jsonapiModule.helpers
       * @param {string} name - Name of a (potential) relationship
       * returns {boolean} true if the name given is a relationship of this object
       */
      isRel(name) {
        return hasProperty(get(obj, [jvtag, 'relationships'], {}), name)
      },
      /**
       * @memberof module:jsonapi-vuex.jsonapiModule.helpers
       * @param {string} name - Name of a (potential) attribute
       * returns {boolean} true if the name given is an attribute of this object
       */
      isAttr(name) {
        return name !== jvtag && hasProperty(obj, name) && !this.isRel(name)
      },
    })
  }

  /**
   * @memberof module:jsonapi-vuex.jsonapiModule.helpers
   * @name rels
   * @property {object} - An object containing all relationships for this object
   */
  Object.defineProperty(obj[jvtag], 'rels', {
    get() {
      const rel = {}
      for (let key of Object.keys(get(obj, [jvtag, 'relationships'], {}))) {
        rel[key] = obj[key]
      }
      return rel
    },
    // Allow to be redefined
    configurable: true,
  })
  /**
   * @memberof module:jsonapi-vuex.jsonapiModule.helpers
   * @name attrs
   * @property {object} - An object containing all attributes for this object
   */
  Object.defineProperty(obj[jvtag], 'attrs', {
    get() {
      const att = {}
      for (let [key, val] of Object.entries(obj)) {
        if (this.isAttr(key)) {
          att[key] = val
        }
      }
      return att
    },
    // Allow to be redefined
    configurable: true,
  })
  return obj
}

/**
 * An incrementing counter, returning a new id to be used for action statuses.
 * If `actionStatusCleanAge` is set, also sets up a timer to call deleetStatus for
 * this id when the timeout is reached.
 * See {@link module:jsonapi-vuex~Configuration|Configuration}
 * @memberof module:jsonapi-vuex._internal
 * @param {object} context - Vuex actions context object
 * @return {integer} A new status id
 */
const actionSequence = (context) => {
  // Increment the global action id, set up a cleanup timeout and return it
  let id = ++actionSequenceCounter
  if (jvConfig.actionStatusCleanAge > 0) {
    setTimeout(
      context.commit,
      jvConfig.actionStatusCleanAge * 1000,
      'deleteStatus',
      id
    )
  }
  return id
}

/**
 * If `preserveJSON` is set, add the returned JSONAPI in a get action to _jv.json
 * See {@link module:jsonapi-vuex~Configuration|Configuration}
 * @memberof module:jsonapi-vuex._internal
 * @param {object} data - Restructured record
 * @param {object} json - JSONAPI record
 * @return {object} data record, with JSONAPI added in _jv.json
 */
const preserveJSON = (data, json) => {
  if (jvConfig.preserveJson && data) {
    if (!hasProperty(data, jvtag)) {
      data[jvtag] = {}
    }
    // Store original json in _jv, then delete data section
    data[jvtag]['json'] = json
    delete data[jvtag]['json']['data']
  }
  return data
}

/**
 * If `followRelationshipData` is set, call `followRelationships` for either an item or a collection
 * See {@link module:jsonapi-vuex~Configuration|Configuration}
 * @memberof module:jsonapi-vuex._internal
 * @param {object} state - Vuex state object
 * @param {object} getters - Vuex getters object
 * @param {object} records - Record(s) to follow relationships for.
 * @param {array} seen - internal recursion state-tracking
 * @return {object} records with relationships followed
 */
const checkAndFollowRelationships = (state, getters, records, seen) => {
  if (jvConfig.followRelationshipsData) {
    let resData = {}
    if (hasProperty(records, jvtag)) {
      // single item
      resData = followRelationships(state, getters, records, seen)
    } else {
      // multiple items
      for (let [key, item] of Object.entries(records)) {
        resData[key] = followRelationships(state, getters, item, seen)
      }
    }
    if (resData) {
      return resData
    }
  }
  return records
}

/**
 * A thin wrapper around `getRelationships, making a copy of the object.
 * We can't add rels to the original object, otherwise Vue's watchers
 * spot the potential for loops (which we are guarding against) and throw an error
 *
 * @memberof module:jsonapi-vuex._internal
 * @param {object} state - Vuex state object
 * @param {object} getters - Vuex getters object
 * @param {object} record - Record to get relationships for.
 * @param {array} seen - internal recursion state-tracking
 * @return {object} records with relationships followed and helper functions added (see {@link module:jsonapi-vuex.utils.addJvHelpers})
 */
const followRelationships = (state, getters, record, seen) => {
  let data = {}

  Object.defineProperties(data, Object.getOwnPropertyDescriptors(record))

  let relationships = getRelationships(getters, data, seen)
  Object.defineProperties(data, Object.getOwnPropertyDescriptors(relationships))

  return addJvHelpers(data)
}

/**
 * Transform args to always be an array (data and config options).
 * See {@link module:jsonapi-vuex.jsonapiModule.actions} for an explanation of why this function is needed.
 *
 * @memberof module:jsonapi-vuex._internal
 * @param {(string|array)} args - Array of data and configuration info
 * @return {array} Array of data and config options
 */
const unpackArgs = (args) => {
  if (Array.isArray(args)) {
    return args
  }
  return [args, {}]
}

/**
 * Get the type, id and relationships from a restructured object
 * @memberof module:jsonapi-vuex.utils
 * @param {object} data - A restructured object
 * @return {array} An array (optionally) containing type, id and rels
 */
const getTypeId = (data) => {
  let type, id, rel
  if (typeof data === 'string') {
    ;[type, id, rel] = data.replace(/^\//, '').split('/')
  } else {
    ;({ type, id } = data[jvtag])
  }

  // Spec: The values of the id and type members MUST be strings.
  // uri encode to prevent mis-interpretation as url parts.
  // Strip any empty strings (falsey items)
  return [
    type && encodeURIComponent(type),
    id && encodeURIComponent(id),
    rel && encodeURIComponent(rel),
  ].filter(Boolean)
}

/**
 * Return the URL path (links.self) or construct from type/id
 * @memberof module:jsonapi-vuex.utils
 * @param {object} data - A restructured object
 * @return {string} The record's URL path
 */
const getURL = (data, post = false) => {
  let path = data
  if (typeof data === 'object') {
    if (get(data, [jvtag, 'links', 'self']) && !post) {
      path = data[jvtag]['links']['self']
    } else {
      let { type, id } = data[jvtag]
      path = type
      // POST endpoints are always to collections, not items
      if (id && !post) {
        path += '/' + id
      }
    }
  }
  return path
}

/**
 * Restructure a single jsonapi item. Used internally by {@link module:jsonapi-vuex.utils.jsonapiToNorm}
 * @memberof module:jsonapi-vuex._internal
 * @param {object} data - JSONAPI record
 * @return {object} Restructured data
 */
const jsonapiToNormItem = (data) => {
  if (!data) {
    return {}
  }
  // Move attributes to top-level, nest original jsonapi under _jv
  const norm = Object.assign({ [jvtag]: data }, data['attributes'])
  // Create a new object omitting attributes
  const { attributes, ...normNoAttrs } = norm[jvtag] // eslint-disable-line no-unused-vars
  norm[jvtag] = normNoAttrs
  return norm
}

/**
 * Convert JSONAPI record(s) to restructured data
 * @memberof module:jsonapi-vuex.utils
 * @param {object} data - The `data` object from a JSONAPI record
 * @return {object} Restructured data
 */
const jsonapiToNorm = (data) => {
  const norm = {}
  if (Array.isArray(data)) {
    data.forEach((item) => {
      let { id } = item
      if (!hasProperty(norm, id)) {
        norm[id] = {}
      }
      Object.assign(norm[id], jsonapiToNormItem(item))
    })
  } else {
    Object.assign(norm, jsonapiToNormItem(data))
  }
  return norm
}

/**
 * Convert a single restructured item to JSONAPI. Used internally by {@link module:jsonapi-vuex.utils.normToJsonapi}
 * @memberof module:jsonapi-vuex._internal
 * @param {object} data - Restructured data
 * @return {object}  JSONAPI record
 */
const normToJsonapiItem = (data) => {
  const jsonapi = {}
  //Pick out expected resource members, if they exist
  for (let member of ['id', 'type', 'relationships', 'meta', 'links']) {
    if (hasProperty(data[jvtag], member)) {
      jsonapi[member] = data[jvtag][member]
    }
  }
  // User-generated data (e.g. post) has no helper functions
  if (hasProperty(data[jvtag], 'attrs')) {
    jsonapi['attributes'] = data[jvtag].attrs
  } else {
    jsonapi['attributes'] = Object.assign({}, data)
    delete jsonapi['attributes'][jvtag]
  }
  return jsonapi
}

/**
 * Convert one or more restructured records to jsonapi
 * @memberof module:jsonapi-vuex.utils
 * @param {object} record - A restructured record to be convert to JSONAPI
 * @return {object} JSONAPI record
 */
const normToJsonapi = (record) => {
  const jsonapi = []
  if (!hasProperty(record, jvtag)) {
    // Collection of id-indexed records
    for (let item of Object.values(record)) {
      jsonapi.push(normToJsonapiItem(item))
    }
  } else {
    jsonapi.push(normToJsonapiItem(record))
  }
  if (jsonapi.length === 1) {
    return { data: jsonapi[0] }
  } else {
    return { data: jsonapi }
  }
}

/**
 * Convert one or more restructured records to nested (type & id) 'store' object
 * @memberof module:jsonapi-vuex.utils
 * @param {object} record - A restructured record to be convert to JSONAPI
 * @return {object} Structured 'store' object
 */
const normToStore = (record) => {
  let store = {}
  if (hasProperty(record, jvtag)) {
    // Convert item to look like a collection
    record = { [record[jvtag]['id']]: record }
  }
  for (let item of Object.values(record)) {
    const { type, id } = item[jvtag]
    if (!hasProperty(store, type)) {
      store[type] = {}
    }
    if (jvConfig.followRelationshipsData) {
      for (let rel in item[jvtag].rels) {
        delete item[rel]
      }
    }
    store[type][id] = item
  }
  return store
}

/**
 * Restructure all records in 'included' (using {@link module:jsonapi-vuex._internal.jsonapiToNormItem})
 * and add to the store.
 * @memberof module:jsonapi-vuex._internal
 * @param {object} context - Vuex actions context object
 * @param {object} results - JSONAPI record
 */
const processIncludedRecords = (context, results) => {
  for (let item of get(results, ['data', 'included'], [])) {
    const includedItem = jsonapiToNormItem(item)
    context.commit('addRecords', includedItem)
  }
}

/**
 * A collection of utility functions
 * @namespace utils
 * @memberof module:jsonapi-vuex
 */
const utils = {
  addJvHelpers: addJvHelpers,
  cleanPatch: cleanPatch,
  deepCopy: deepCopy,
  getTypeId: getTypeId,
  getURL: getURL,
  jsonapiToNorm: jsonapiToNorm,
  normToJsonapi: normToJsonapi,
  normToStore: normToStore,
}

// Export a single object with references to 'private' functions for the test suite
/**
 * An object containing references to all internal functions for the test suite to import
 * @memberof module:jsonapi-vuex._internal
 */
const _testing = {
  _copy: _copy,
  actionSequence: actionSequence,
  getTypeId: getTypeId,
  deepCopy: deepCopy,
  jsonapiToNorm: jsonapiToNorm,
  jsonapiToNormItem: jsonapiToNormItem,
  normToJsonapi: normToJsonapi,
  normToJsonapiItem: normToJsonapiItem,
  normToStore: normToStore,
  processIncludedRecords: processIncludedRecords,
  unpackArgs: unpackArgs,
  followRelationships: followRelationships,
  jvConfig: jvConfig,
  RecordError: RecordError,
  addJvHelpers: addJvHelpers,
  updateRecords: updateRecords,
  getURL: getURL,
  cleanPatch: cleanPatch,
  getRelationships: getRelationships,
}

export { jsonapiModule, utils, _testing }
