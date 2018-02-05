/*
 * Copyright 2017 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const http = require('http')
const Promise = require('bluebird')
const agent = require('superagent-promise')(require('superagent'), Promise)
const fs = require("fs");
const _ = require('lodash')
const schema = require('@signalk/signalk-schema')

const stateMapping = {
  0: 'motoring',
  1: 'anchored',
  2: 'not under command',
  3: 'restricted manouverability',
  4: 'constrained by draft',
  5: 'moored',
  6: 'aground',
  7: 'fishing',
  8: 'sailing',
  9: 'hazardous material high speed',
  10: 'hazardous material wing in ground',
  14: 'ais-sart',
  15: undefined
}

module.exports = function(app)
{
  var plugin = {};
  var timeout = undefined
  let selfContext = 'vessels.' + app.selfId
  
  plugin.id = "signalk-aishub-ws"
  plugin.name = "AisHub WS"
  plugin.description = plugin.name

  plugin.schema = {
    type: "object",
    required: [
      "apikey", "url"
    ],
    properties: {
      apikey: {
        type: "string",
        title: "API Key"
      },
      url: {
        type: "string",
        title: "AisHub URL",
        default: "http://data.aishub.net/ws.php"
      },
      updaterate: {
        type: "number",
        title: "Rate to get updates from AisHub (s > 60)",
        default: 61
      },
      boxSize: {
        type: "number",
        title:"Size of the bounding box to retrieve data (km)",
        default: 10
      }
    }
  }

  function aisHubToDeltas(response)
  {
    var hub = JSON.parse(response)
    //app.debug("response: " + JSON.stringify(hub))
    var status = hub[0]
    if ( status.ERROR )
    {
      console.error("error response from AisHub: " + JSON.stringify(status))
      return
    }

    hub[1].forEach(vessel => {
      app.debug('found vessel %j', vessel)
      var delta = getVesselDelta(vessel)

      if ( delta == null ) {
        return
      }

      /*
      var existing = app.signalk.root.vessels["urn:mrn:imo:mmsi:" + vessel.MMSI]

      if ( existing )
      {
        var ts = _.get(existing, "navigation.position.timestamp")
        if ( ts )
        {
          var existingDate = new Date(ts)
          
        }
      }*/
      
      app.debug("vessel delta:  %j", delta)
      app.handleMessage(plugin.id, delta)
    })
  }

  function getVesselDelta(vessel)
  {
    var context = "vessels.urn:mrn:imo:mmsi:" + vessel.MMSI;

    if ( context == selfContext ) {
      debug(`ignorning vessel: ${context}`)
      return null
    }
    
    var delta = {
      "context": context,
      "updates": [
        {
          "timestamp": convertTime(vessel, vessel.TIME),
          "source": {
            "label": "aishub"
          },
          "values": []
        }
      ]
    }
    mappings.forEach(mapping => {
      var val = vessel[mapping.key]
      if ( typeof val !== 'undefined' )
      {
        if ( typeof val === 'string' && val.length == 0 )
          return

        if ( mapping.conversion )
        {
          val = mapping.conversion(vessel, val)
          if ( val == null )
            return
        }
        var path = mapping.path
        if ( mapping.root )
        {
          var nval = {}
          nval[path] = val
          val = nval
          path = ''
        }
        addValue(delta, path, val)
      }
    })
    return delta;
  }
  
  plugin.start = function(options)
  {
    var update = function()
    {
      var position = app.getSelfPath('navigation.position')
      app.debug("position: %o", position)
      if ( typeof position !== 'undefined' && position.value )
        position = position.value
      if ( typeof position == 'undefined' || typeof position.latitude == 'undefined' || typeof position.longitude === 'undefined' )
      {
        app.debug("no position available")
        return
      }

      var box = calc_boundingbox(options, position)
      publishBox(app, box)

      var url = options.url + "?username=" + options.apikey + "&format=1&output=json&compress=0&latmin=" + box.latmin + "&latmax=" + box.latmax + "&lonmin=" + box.lonmin + "&lonmax=" + box.lonmax

      app.debug("url: " + url)

      agent('GET', url).end().then(function(response) {
        aisHubToDeltas(response.text)
      })

        /*
      var text = fs.readFile("hub.json", 'utf8', function(err,data) {
        aisHubToDeltas(data)
      })
        */
      //app.debug("update: " + res)
    }

    var rate = options.updaterate

    if ( !rate || rate <=60 )
      rate = 61
    //rate = 1
    update()
    timeout = setInterval(update, rate * 1000)
  }

  plugin.stop = function()
  {
    if ( timeout ) {
      clearInterval(timeout)
      timeout = undefined
    }
  }

  return plugin
}
         
function degsToRadC(vessel, degrees) {
  return degrees * (Math.PI/180.0);
}

function degsToRad(degrees) {
  return degrees * (Math.PI/180.0);
}

function radsToDeg(radians) {
  return radians * 180 / Math.PI
}

function addValue(delta, path, value)
{
  if ( typeof value !== 'undefined' )
  {
    delta.updates[0].values.push({path: path, value: value})
  }
}

function convertTime(vessel, val)
{
  var tparts = val.split(' ')
  return tparts[0] + "T" + tparts[1] + "Z"
}

function numberToString(vessel, num)
{
  return '' + num
}

const mappings = [
  {
    path: "mmsi",
    key: "MMSI",
    root: true,
    conversion: numberToString
  },
  {
    path: "name",
    key: "NAME",
    root: true
  },
  {
    path: "callsign",
    key: "CALLSIGN",
    root: true
  },
  {
    path: "imo",
    key: "IMO",
    root: true,
    conversion: numberToString
  },
  {
    path: "navigation.courseOverGroundTrue",
    key: "COG",
    conversion: function(vessel, val) {
      if ( val == 360 )
        return null;
      return degsToRadC(vessel, val)
    }
  },
  {
    path: "navigation.headingTrue",
    key: "HEADING",
    conversion: function(vessel, val) {
      if ( val == 511 )
        return null;
      return degsToRadC(vessel, val);
    }
  },
  {
    path: "navigation.destination.commonName",
    key: "DEST"
  },
  {
    path: "sensors.ais.fromBow",
    key: 'A',
    conversion: function(vessel, val) {
      var length = vessel.A + vessel.B
      if ( length == 0 )
        return null
      return val
    }
  },
  {
    path: "sensors.ais.fromCenter",
    key: 'C',
    conversion: function(vessel, to_port) {
      var to_starboard = vessel.D
      var to_port = vessel.C
      var width = to_port + to_starboard

      if ( width == 0 )
        return null
      
      if ( to_starboard > (width/2) )
      {
        return (to_starboard - (width/2)) * -1;
      }
      else
      {
        return (width/2) - to_starboard;
      }
    }
  },
  {
    path: "design.length",
    key: "A",
    conversion: function(vessel, to_bow) {
      var to_stern = vessel.B
      var length = to_stern + to_bow
      if ( length == 0 )
        return null
      return { overall: length }
    }
  },
  {
    path: "design.beam",
    key: "C",
    conversion: function(vessel, to_port) {
      var to_starboard = vessel.D
      var beam = to_port + to_starboard
      if ( beam == 0 )
        return null
      return beam
    }
  },
  {
    path: "design.draft",
    key: "DRAUGHT",
    conversion: function(vessel, val) {
      if ( val == 0 )
        return null
      return { maximum: val }
    }
  },
  {
    path: 'navigation.position',
    key: "LATITUDE",
    conversion: function(vessel, val) {
      return { latitude: val, longitude:vessel.LONGITUDE }
    }
  },
  {
    path: "navigation.speedOverGround",
    key: "SOG",
    conversion: function(vessel, val) {
      if ( val == 102.4 )
        return null;
      return val * 0.514444
    }
  },
  {
    path: "design.aisShipType",
    key: "TYPE",
    conversion: function(vessel, val) {
      const name = schema.getAISShipTypeName(val)
      if ( name ) {
        return { id: val, 'name': name }
      } else {
        return null
      }
    }
  },
  {
    path: "navigation.state",
    key: "NAVSTAT",
    conversion: function(vessel, val) {
      var res = stateMapping[val]
      return res ? res : undefined
    }
  },
  {
    path: "navigation.courseGreatCircle.activeRoute.estimatedTimeOfArrival",
    key: "ETA",
    conversion: convertTime
  }
]


function mod(x,y){
  return x-y*Math.floor(x/y)
}

function calc_position_from(position, heading, distance)
{
  var dist = (distance / 1000) / 1.852  //m to nm
  dist /= (180*60/Math.PI)  // in radians

  heading = (Math.PI*2)-heading
  
  var lat = Math.asin(Math.sin(degsToRad(position.latitude)) * Math.cos(dist) + Math.cos(degsToRad(position.latitude)) * Math.sin(dist) * Math.cos(heading))
  
  var dlon = Math.atan2(Math.sin(heading) * Math.sin(dist) * Math.cos(degsToRad(position.latitude)), Math.cos(dist) - Math.sin(degsToRad(position.latitude)) * Math.sin(lat))
  
  var lon = mod(degsToRad(position.longitude) - dlon + Math.PI, 2 * Math.PI) - Math.PI
  
  return { "latitude": radsToDeg(lat),
           "longitude": radsToDeg(lon) }
}

function calc_boundingbox(opions, position)
{
  var dist = opions.boxSize

  if ( ! dist )
    dist = 10
  dist = (dist/2) * 1000

  var min_lon = calc_position_from(position, 4.5, dist)
  var max_lon = calc_position_from(position, 1.5, dist)
  var max_lat = calc_position_from(position, 0, dist)
  var min_lat = calc_position_from(position, 3.0, dist)
  return {
    'latmin': min_lat.latitude,
    'latmax': max_lat.latitude,
    'lonmin': min_lon.longitude,
    'lonmax': max_lon.longitude
  }
}

function publishBox(app, box)
{
  var delta = {
    "context": "vessels." + app.selfId,
    "updates": [
      {
        "source": {
          "label": "aishub"
        },
        "values": [
          {
            path: "sensors.ais.boundingBox",
            value: box
          }
        ]
      }
    ]
    }
  app.signalk.addDelta(delta)
}
