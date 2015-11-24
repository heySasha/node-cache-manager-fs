/*eslint-env node, mocha */

'use strict';

/**
 * Module dependencies
 */
var noop = function noop() {};
var fs = require('fs');
var fsp = require('fs-promise');
var crypto = require('crypto');
var path = require('path');
var async = require('async');
var extend = require('extend');
 
/**
 * Export 'DiskStore'
 */

module.exports = {
	create : function main (args) {
		return new DiskStore(args && args.options ? args.options : args);
	}
};

/**
 * helper object with meta-informations about the cached data
 */
function MetaData () {

	// the key for the storing
	this.key = null;
	// data to store
	this.value = null;
	// temporary filename for the cached file because filenames cannot represend urls completely
	this.filename = null;
	// expirydate of the entry
	this.expires = null;
	// size of the current entry
	this.size = null;
}

/**
 * construction of the disk storage
 */
function DiskStore (options) {
	options = options || {};

	this.options = extend({
		path: 'cache/',
		ttl: 60,
		maxsize: 0
	}, options);


  // check storage directory for existence (or create it)
  if (!fs.existsSync(this.options.path)) {
		fs.mkdirSync(this.options.path);
  }
  
  this.name = 'diskstore';

  // current size of the cache
  this.currentsize = 0;

  // internal array for informations about the cached files - resists in memory
  this.collection = {};

  // fill the cache on startup with already existing files
  if (!options.preventfill) {

		this.intializefill(options.fillcallback);
	}
}


/**
 * indicate, whether a key is cacheable
 */
DiskStore.prototype.isCacheableValue = function isCacheableValue(value) {

	return value !== null && value !== undefined;
};

/**
 * delete an entry from the cache
 */
DiskStore.prototype.del = function del(key, callback) {

  var cb = typeof callback === 'function' ? callback : noop;

  // get the metainformations for the key
	var metaData = this.collection[key];

	if (!metaData) {

		return cb(null);
	}

  // check if the filename is set
  if (!metaData.filename) {
		return cb(null);
  }

  // check for existance of the file
  fsp.exists(metaData.filename).
  then(function exists(exists) {
	if (exists) {
		return;
	}
	reject();
  })
  .then(function unlink() {
	// delete the file
	fsp.unlink(metaData.filename);
  }, function notfound() {
	// not found
	cb(null);
  }).then(function update() {
	// update internal properties
	this.currentsize -= metaData.size;
	this.collection[key] = null;
	delete this.collection[key];
	cb(null);
  }.bind(this)).catch(function error() {
	cb(null);
  });
};

/**
 * set a key into the cache
 */
DiskStore.prototype.set = function set(key, val, options, callback) {
	
  var cb = typeof callback === 'function' ? callback : noop;
  if (typeof options === 'function') {
		cb = options;
		options = null;
  }

  // get ttl
  var ttl = (options && (options.ttl || options.ttl === 0)) ? options.ttl : this.options.ttl;  

  var metaData = extend({}, new MetaData(), {
	key: key,
	value: val,
	expires: Date.now() + ((ttl || 60) * 1000),
	filename: this.options.path + '/cache_' + crypto.randomBytes(4).readUInt32LE(0) + '.dat'
  });

  var stream = JSON.stringify(metaData);

  metaData.size = stream.length;

  if (this.options.maxsize && metaData.size > this.options.maxsize) {
	return cb('Item size too big.');
  }

  // remove the key from the cache (if it already existed, this updates also the current size of the store)
  this.del(key, function del(err) {

		if (err) {
			return cb(err);
		}

		// check used space and remove entries if we use to much space
		this.freeupspace(function freeup() {
			try {
				// write data into the cache-file
				fs.writeFile(metaData.filename, stream, function error(err) {

				if (err) {
					return cb(err);
				}

				// remove data value from memory
				metaData.value = null;
				delete metaData.value;

				this.currentsize += metaData.size;

				// place element with metainfos in internal collection
				this.collection[metaData.key] = metaData;
				return cb(null, val);

				}.bind(this));

		  } catch (err) {

				return cb(err);
		  }

		}.bind(this));

  }.bind(this));

};

/**
 * helper method to free up space in the cache (regarding the given spacelimit)
 */
DiskStore.prototype.freeupspace = function freeupspace(cb) {

  cb = typeof cb === 'function' ? cb : noop;

  if (!this.options.maxsize) {
		return cb(null);
  }

  // do we use to much space? then cleanup first the expired elements
  if (this.currentsize > this.options.maxsize) {
		this.cleanExpired();
  }

  // when the spaceusage is to high, remove the oldest entries until we gain enough diskspace
  if (this.currentsize <= this.options.maxsize) {
  	return cb(null);
  }
  
	// for this we need a sorted list basend on the expire date of the entries (descending)
	var tuples = [], key;
	for (key in this.collection) {
		if (!this.collection.hasOwnProperty(key))
		{
			continue;
		}
		tuples.push([key, this.collection[key].expires]);
		
	}

	tuples.sort(function sort (a, b) {

		a = a[1];
		b = b[1];
		return a < b ? 1 : (a > b ? -1 : 0);
	});
	
	return this.freeupspacehelper(tuples, cb);
};

/**
 * freeup helper for asnyc space freeup
 */
DiskStore.prototype.freeupspacehelper = function freeupspacehelper(tuples, cb) {

	// check, if we have any entry to process
	if (tuples.length === 0) {
		return cb(null);
	}
	
	// get an entry from the list	
	var tuple = tuples.pop();
	var key = tuple[0];
	
	// delete an entry from the store
	this.del(key, function deleted (err) {
		
		// return when an error occures
		if (err) {
		  return cb(err);
		}
		
		// stop processing when enouth space has been cleaned up 
		if (this.currentsize <= this.options.maxsize) {
			return cb(err);
		}

		// ok - we need to free up more space							
		return this.freeupspacehelper(tuples, cb);
	}.bind(this));
};

/**
 * get entry from the cache
 */
DiskStore.prototype.get = function get(key, cb) {

	cb = typeof cb === 'function' ? cb : noop;

  // get the metadata from the collection
  var data = this.collection[key];

  if (!data) {

	  // not found
	  return cb(null, null);
  }

  // found but expired
  if (data.expires < new Date()) {

	  // delete the elemente from the store
	  this.del(key, function err(err) {
		return cb(err, null);	  
	  });	  
  } else {

		// try to read the file
		try {

			fs.readFile(data.filename, function callback(err, fileContent) {
				if (err) {
					return cb(err);
				}
					
				var diskdata = JSON.parse(fileContent);
				cb(null, diskdata.value);
			});

		} catch (err) {

			cb(err);
		}
  }
};

DiskStore.prototype.keys = function keys(cb)
{
	var keys = [];
	for (var key in this.collection) {
		if (this.collection.hasOwnProperty(key)) { //to be safe
			keys.push(key);
		}
	}
	if (cb) {
		cb(null, keys);
		return;
	}

	return keys;
};

/**
 * cleanup cache on disk -> delete all used files from the cache
 */
DiskStore.prototype.reset = function reset(key, cb) {

  cb = typeof cb === 'function' ? cb : noop;

  if (typeof key === 'function') {
		cb = key;
		key = null;
  }

  if (Object.keys(this.collection).length === 0) {
		return cb(null);
  }

  try {

		// delete special key
		if (key !== null) {

		  this.del(key);
		  return cb(null);
		}

		async.eachSeries(this.collection, 
			function del(elementKey, callback) {

				this.del(elementKey);
				callback();
			}.bind(this), 
			function error() {
				cb(null);
			}
		);

  } catch (err) {

		return cb(err);
  }

};

/**
 * helper method to clean all expired files
 */
DiskStore.prototype.cleanExpired = function cleanExpired() {
	var key, entry;
	for (key in this.collection) 
	{
		if (!this.collection.hasOwnProperty(key))
		{
			continue;
		}		
		entry = this.collection[key];
		if (entry.expires < new Date()) {
			this.del(entry.key);
		}
	}
};

/**
 * clean the complete cache and all(!) files in the cache directory
 */
DiskStore.prototype.cleancache = function cleancache(cb) {

	cb = typeof cb === 'function' ? cb : noop;

  // clean all current used files
  this.reset();

  // check, if other files still resist in the cache and clean them, too
  var files = fs.readdirSync(this.options.path);

  files
  	.map(function pathjoin(file) {
	  	return path.join(this.options.path, file);
  	}.bind(this))
  	.filter(function filter(file) {
	  	return fs.statSync(file).isFile();
  	}.bind(this))
  	.forEach(function unlink(file) {
	  	fs.unlinkSync(file);
  	}.bind(this));
  cb(null);

};

/**
 * fill the cache from the cache directory (usefull e.g. on server/service restart)
 */
DiskStore.prototype.intializefill = function intializefill(cb) {
  
	cb = typeof cb === 'function' ? cb : noop;

  // get the current working directory
  fs.readdir(this.options.path, function getfiles(err, files) {

		// get potential files from disk
		files = files.map(function pathjoin(filename) {

				return path.join(this.options.path, filename);
			}.bind(this)).filter(function filterforfiles(filename) {

				return fs.statSync(filename).isFile();
			});
		
		// use async to process the files and send a callback after completion
		async.eachSeries(files, function processfile(filename, callback) {

		  fs.readFile(filename, function readFile(err, data) {

				// stop file processing when there was an reading error
				if (err) {
				  return callback();
				}

				var diskdata;
				try {

				  // get the json out of the data
				  diskdata = JSON.parse(data);

				} catch (err) {

				  // when the deserialize doesn't work, probably the file is uncomplete - so we delete it and ignore the error
				  try {
				  	fs.unlinksync(filename);
				  } catch (ignore) {
					return callback();
				  }
				  return callback();
				}

				// update the size in the metadata - this value isn't correctly stored in the file
				diskdata.size = data.length;

				// update collection size
				this.currentsize += data.length;

				// remove the entrys content - we don't want the content in the memory (only the meta informations)
				diskdata.value = null;
				delete diskdata.value;

				// and put the entry in the store
				this.collection[diskdata.key] = diskdata;

				// check for expiry - in this case we instantly delete the entry
				if (diskdata.expires < new Date()) {

				  this.del(diskdata.key, function delcallback() {

						return callback();
				  });
				} else {

				  return callback();
				}
		  }.bind(this));
		
		}.bind(this), function error(err) {

		  cb(err || null);

		});

  }.bind(this));

};
