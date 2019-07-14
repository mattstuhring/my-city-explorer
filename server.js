'use strict';

// Initialize ENV configs
require('dotenv').config();

// NPM Packages
const express = require('express');
const cors = require('cors');
const superagent = require('superagent');
const pg = require('pg');

// Global Variables
const PORT = process.env.PORT;

// DB Setup
const client = new pg.Client(process.env.DATABASE_URL);
client.connect();
client.on('error', err => console.error('PG DB ERROR: ', err));

const app = express(); // Instantiate Express app
app.use(cors()); // Cross Origin support

// Server Express static files from public directory
app.use(express.static('public'));

// Routes
// ---------------------------------------------
app.get('/location', getLocation); // user location input, display on map
app.get('/weather', getWeather); //daily weather details from location
app.get('/events', getEvents); // Events by location
app.get('/movies', getMovies); // Movies related to location
app.get('/yelp', getYelps); // Businesses near location

// 404 - catch all paths that are not defined
// ---------------------------------------------
app.use('*', (request, response) => {
  response.status(404).send('Sorry, page not found');
});

// Start the server!!!
// --------------------
app.listen(PORT, () => {
  console.log(`Listening on PORT:${PORT}`);
});


// SQL insert queries
const SQL_INSERTS = {
  locations: `INSERT INTO locations(
    created_at,
    latitude,
    longitude,
    search_query,
    formatted_query
  ) VALUES($1, $2, $3, $4, $5) RETURNING *`,

  weathers: `INSERT INTO weathers(
    created_at,
    forecast,
    time,
    location_id
  ) VALUES ($1, $2, $3, $4) RETURNING *`,

  events: `INSERT INTO events(
    created_at, 
    link, 
    name, 
    event_date, 
    summary, 
    location_id
  ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,

  movies: `INSERT INTO movies(
    created_at, 
    title, 
    overview, 
    average_votes, 
    total_votes, 
    image_url, 
    popularity, 
    released_on, 
    location_id
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,

  yelps: `INSERT INTO yelps(
    created_at, 
    name, 
    image_url, 
    price, 
    rating, 
    url, 
    location_id
  ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`
};

// Location - constructor
// ******************************
function Location(locationName, result) {
  this.created_at = Date.now();
  this.search_query = locationName;
  this.formatted_query = result.body.results[0].formatted_address;
  this.latitude = result.body.results[0].geometry.location.lat;
  this.longitude = result.body.results[0].geometry.location.lng;
}

//Weather - constructor
// ******************************
function Weather(result) {
  this.created_at = Date.now();
  this.time = new Date(result.time * 1000).toDateString();
  this.forecast = result.summary;
}

// Event - constructor
// ******************************
function Event(result) {
  this.created_at = Date.now();
  this.link = result.url;
  this.name = result.name.text;
  this.event_date = new Date(result.start.local).toDateString();
  this.summary = result.description.text;
}

// Movies - constructor
// ***************************
function Movie(movie) {
  this.tableName = 'movies';
  this.created_at = Date.now();
  this.title = movie.title;
  this.overview = movie.overview;
  this.average_votes = movie.vote_average;
  this.total_votes = movie.vote_count;
  this.image_url = `https://image.tmdb.org/t/p/w500/${movie.poster_path}`;
  this.popularity = movie.popularity;
  this.released_on = movie.release_date;
}

// Yelp - constructor
// ***************************
function Yelp(yelp) {
  this.created_at = Date.now();
  this.name = yelp.name;
  this.image_url = yelp.image_url;
  this.price = yelp.price;
  this.rating = yelp.rating;
  this.url = yelp.url;
}

// Check if API data is old, if true request new data from API
// ----------------------------------------------------------------
function checkCachedData(url, result, tableName, period, locationId, response) {
  console.log('AGE: ', Date.now() - result.rows[0].created_at);

  if (Date.now() - result.rows[0].created_at > period) {
    const SQL = `DELETE FROM ${tableName} WHERE location_id=${result.rows[0].location_id}`;

    client.query(SQL).then((result) => {
      console.log('DELETE RESULTS: ', result)

      cacheUpdate(url, tableName, locationId, response)
    });
  } else {
    return response.send(result.rows);
  }
}

// Look up data from the DB
// ---------------------------
function lookupDB(url, tableName, locationId, response) {
  return client.query(`SELECT * FROM ${tableName} WHERE location_id = $1`, [locationId])
    .then(sqlResult => {
      if (sqlResult.rowCount === 0) {
        // Get new data from API and update DB
        return cacheUpdate(url, tableName, locationId, response);
      } else {
        // Send cached data from DB
        return cacheSend(url, sqlResult, tableName, locationId, response);
      }
    })
    .catch(err => {
      console.error('Something went wrong: ', err);
    });
}

// Request new data from API and update DB
// ---------------------------------------------
function cacheUpdate(url, tableName, locationId, response) {
  console.log('Request new data from API');
  let superagentRequest = superagent.get(url);

  if (tableName === 'yelps') {
    console.log('yelps');
    superagentRequest = superagent.get(url).set('Authorization', `Bearer ${process.env.YELP_API_KEY}`);
  }

  return superagentRequest
    .then(result => {
      return handleInsertDB(result, tableName, locationId);
    })
    .then(results => {
      return Promise.all(results)
        .then(result => {
          return response.status(200).send(result);
        })
        .catch(err => {
          console.error('Promise.all() failed: ', err);
        });
    })
    .catch(err => {
      console.error(err);
      response.status(500).send('Sorry, something went wrong.');
    });
}

// Data exists!  Send cached data from the DB
// ----------------------------------------------
function cacheSend(url, sqlResult, tableName, locationId, response) {
  console.log('Sending old data from DB');

  if (tableName === 'weathers') {
    // Check if weather data is older than 15 seconds, if true go get new data
    return checkCachedData(url, sqlResult, 'weathers', 15000, locationId, response);
  } else {
    return response.status(200).send(sqlResult.rows);
  }  
}


// Select the correct insert query into DB for each API request result
// ---------------------------------------------------
function handleInsertDB(result, tableName, locationId) {
  let api;

  switch (tableName) {
  case 'weathers':
    api = handleWeatherInsertDB(result, locationId);

    break;
  case 'events':
    api = handleEventsInsertDB(result, locationId);

    break;
  case 'yelps':
    api = handleYelpsInsertDB(result, locationId);

    break;
  case 'movies':
    api = handleMoviesInsertDB(result, locationId);

    break;
  default:
    console.log('No insert query was selected!');
  }

  return api;
}



// Update weather API data in the DB
// -----------------------------------------
function handleWeatherInsertDB(result, locationId) {
  let promises = result.body.daily.data.map(obj => {
    const day = new Weather(obj);

    return client.query(SQL_INSERTS.weathers, [day.created_at, day.forecast, day.time, locationId])
      .then(result => {
        return result.rows[0];
      })
      .catch(err => {
        console.error(err);
      });
  });

  return promises;
}

// Update Events API data in the DB
// -----------------------------------
function handleEventsInsertDB(result, locationId) {
  let promises = result.body.events.map(obj => {
    const event = new Event(obj);

    return client.query(SQL_INSERTS.events, [event.created_at, event.link, event.name, event.event_date, event.summary, locationId])
      .then(result => {
        return result.rows[0];
      })
      .catch(err => {
        console.error(err);
      });
  });

  return promises;
}

// Update Movies API data in the DB
// -----------------------------------
function handleMoviesInsertDB(result, locationId) {
  let promises = result.body.results.map(obj => {
    const movie = new Movie(obj);

    return client.query(SQL_INSERTS.movies, [movie.created_at, movie.title, movie.overview, movie.average_votes, movie.total_votes, movie.image_url, movie.popularity, movie.released_on, locationId])
      .then(result => {
        return result.rows[0];
      })
      .catch(err => {
        console.error(err);
      });
  });

  return promises;
}

// Update Yelp API data in the DB
// -----------------------------------
function handleYelpsInsertDB(result, locationId) {
  let promises = result.body.businesses.map(obj => {
    const yelp = new Yelp(obj);

    return client.query(SQL_INSERTS.yelps, [yelp.created_at, yelp.name, yelp.image_url, yelp.price, yelp.rating, yelp.url, locationId])
      .then(result => {
        return result.rows[0];
      })
      .catch(err => {
        console.error(err);
      });
  });

  return promises;
}

// Request location data from the Google Geo API
// --------------------------------------------------
function getLocation(request, response) {
  const locationName = request.query.data;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${locationName}&key=${process.env.GEOCODE_API_KEY}`;

  // Check to see if the query is already in the db
  return client.query(`SELECT * FROM locations WHERE search_query = $1`, [locationName])
    .then(sqlResult => {

      if (sqlResult.rowCount === 0) {
        return superagent
          .get(url)
          .then(result => {
            const location = new Location(locationName, result);

            return client.query(SQL_INSERTS.locations, [location.created_at, location.latitude, location.longitude, location.search_query, location.formatted_query])
              .then(result => {
                response.status(200).send(result.rows[0]);
              })
              .catch(err => {
                console.error(err);
              });
          })
          .catch(err => {
            console.error(err);
            response.status(500).send('Sorry, something went wrong.');
          });
      } else {
        response.send(sqlResult.rows[0]);
      }
    })
    .catch(err => {
      console.error(err);
      response.status(500).send('Sorry, something went wrong.');
    });
}

// Request weather data from the Dark Sky API
// ---------------------------------------------
function getWeather(request, response) {
  const locationId = parseInt(request.query.data.id);
  const lat = request.query.data.latitude;
  const lng = request.query.data.longitude;
  const url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${lat},${lng}`;

  lookupDB(url, 'weathers', locationId, response);
}

// Request EventBrite API data
// -------------------------------
function getEvents(request, response) {
  const locationId = parseInt(request.query.data.id);
  const lat = request.query.data.latitude;
  const lng = request.query.data.longitude;
  const url = `https://www.eventbriteapi.com/v3/events/search/?location.latitude=${lat}&location.longitude=${lng}&token=${process.env.EVENTBRITE_API_KEY}`;

  lookupDB(url, 'events', locationId, response);
}

// Request Movie API data
// -------------------------------
function getMovies(request, response) {
  const locationId = parseInt(request.query.data.id);
  const searchQuery = request.query.data.search_query;
  const url = `https://api.themoviedb.org/3/search/movie?query=${searchQuery}&api_key=${process.env. MOVIE_API_KEY}`;

  lookupDB(url, 'movies', locationId, response);
}

// Request Yelp API data
// -------------------------------
function getYelps(request, response) {
  const locationId = parseInt(request.query.data.id);
  const searchQuery = request.query.data.search_query;
  const url = `https://api.yelp.com/v3/businesses/search?location=${searchQuery}`;

  lookupDB(url, 'yelps', locationId, response);
}
