'use strict';

// Application Dependencies
const express = require('express');
const superagent = require('superagent');
const pg = require('pg');
const cors = require('cors');

// Load environment variables from .env file
require('dotenv').config();

// Application Setup
const app = express();
const PORT = process.env.PORT || 3000;
const timeoutObj = {
  'weathers': 15000
}; //timeout for data

app.use(cors());

// Database Setup
const client = new pg.Client(process.env.DATABASE_URL);
client.connect();
client.on('error', err => console.error(err));

// API Routes
app.get('/location', getLocation);
app.get('/weather', getWeather);
app.get('/events', getEvents);


// Make sure the server is listening for requests
app.listen(PORT, () => console.log(`Listening on ${PORT}`));


// Error handler
function handleError(err, res) {
  console.error(err);
  if (res) res.status(500).send('Sorry, something went wrong');
}

// Look for the results in the database
function lookup(options) {
  const SQL = `SELECT * FROM ${options.tableName} WHERE location_id=$1;`;
  const values = [options.location];

  client.query(SQL, values)
    .then(result => {
      if (result.rowCount > 0) {
        options.cacheHit(result, options.cacheMiss);
      } else {
        options.cacheMiss();
      }
    })
    .catch(error => handleError(error));
}

// Models
function Location(query, res) {
  this.tableName = 'locations';
  this.search_query = query;
  this.formatted_query = res.body.results[0].formatted_address;
  this.latitude = res.body.results[0].geometry.location.lat;
  this.longitude = res.body.results[0].geometry.location.lng;
}

Location.lookupLocation = (location) => {
  const SQL = 'SELECT * FROM locations WHERE search_query=$1;';
  const values = [location.query];
  return client.query(SQL, values)
    .then(result => {
      if (result.rowCount > 0) {
        location.cacheHit(result);
      } else {
        location.cacheMiss();
      }
    })
    .catch(console.error);
};

Location.prototype = {
  save: function () {
    const SQL = 'INSERT INTO locations (search_query, formatted_query, latitude, longitude) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id;';
    const values = [this.search_query, this.formatted_query, this.latitude, this.longitude];

    return client.query(SQL, values)
      .then(result => {
        this.id = result.rows[0].id;
        return this;
      });
  }
};

function Weather(day) {
  this.created_at = Date.now();
  this.tableName = 'weathers';
  this.forecast = day.summary;
  this.time = new Date(day.time * 1000).toString().slice(0, 15);
}

Weather.tableName = 'weathers';
Weather.lookup = lookup;

Weather.prototype = {
  save: function (location_id) {
    const SQL = `INSERT INTO ${this.tableName} (created_at, forecast, time, location_id) VALUES ($1, $2, $3, $4);`;
    const values = [this.created_at, this.forecast, this.time, location_id];
    client.query(SQL, values);
  }
};

function Event(e) {
  this.link = e.url;
  this.name = e.name.text;
  this.event_date = new Date(e.start.utc).toDateString();
  this.summary = e.summary;
}

Event.prototype = {
  save: function (location_id) {
    const SQL = `INSERT INTO ${this.tableName} (link, name, event_date, summary, location_id) VALUES ($1, $2, $3, $4, $5);`;
    const values = [this.link, this.name, this.event_date, this.summary, location_id];

    client.query(SQL, values);
  }
};

Event.tableName = 'events';
Event.lookup = lookup;

function getLocation(request, response) {
  Location.lookupLocation({
    tableName: Location.tableName,
    query: request.query.data,
    cacheHit: function (result) {
      response.send(result.rows[0]);
    },

    cacheMiss: function () {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${this.query}&key=${process.env.GEOCODE_API_KEY}`;
      return superagent.get(url)
        .then(result => {
          const location = new Location(this.query, result);
          location.save()
            .then(location => response.send(location));
        })
        .catch(error => handleError(error));
    }
  });
}

function getWeather(request, response) {
  Weather.lookup({
    tableName: Weather.tableName,
    location: request.query.data.id,
    cacheHit: function (result, cacheMiss) {
      const timeOut = timeoutObj['weathers'];
      const age = Date.now() - result.rows[0].created_at;

      if (age > timeOut) {
        client.query('DELETE FROM weathers WHERE location_id=$1', [result.rows[0].location_id])
          .then(() => cacheMiss());
        console.log('we hit the miss cache');
      } else {
        console.log('young data.  its not that old.');
        response.send(result.rows);
      }
    },

    cacheMiss: function () {
      const url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;
      superagent.get(url)
        .then(result => {
          const weatherSummaries = result.body.daily.data.map(day => {
            const summary = new Weather(day);
            summary.save(request.query.data.id);
            return summary;
          });
          response.send(weatherSummaries);
        })
        .catch(error => handleError(error, response));
    }
  });
}


function getEvents(request, response) {
  Event.lookup({
    tableName: Event.tableName,
    location: request.query.data.id,
    cacheHit: function (result) {
      response.send(result.rows);
    },

    cacheMiss: function () {
      const url = `https://www.eventbriteapi.com/v3/events/search/?location.longitude=${request.query.data.longitude}&location.latitude=${request.query.data.latitude}&expand=venue&token=${process.env.EVENTBRITE_API_KEY}`;
      superagent.get(url)
        .then(result => {
          const eventArray = result.body.events.map(e => {
            const eventObj = new Event(e);
            eventObj.save(request.query.data.id);
            return eventObj;
          });
          response.send(eventArray);
        })
        .catch(error => handleError(error, response));
    }
  });
}