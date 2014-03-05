var nconf = require('nconf').argv(),
    async = require('async'),
    markify = require('../markify.js'),
    brand;

brand = nconf.get('BRAND');
markify.getClassifications(brand, function(err, trademark_owner, include_classes, exclude_classes){
    'use strict';
    if(err){
        console.log('ERROR ' + brand + ': ' + err);
    }
    console.log('DONE ' + brand);
});
