var querystring = require('querystring'),
    util = require('util'),
    request = require('request'),
    assert = require('assert'),
    async = require('async'),
    winston = require('winston'),
    natural = require('natural'),
    dom = require('xmldom').DOMParser,
    xpath = require('xpath'),
	retry = require('retry'),
    nconf = require('nconf');

var config = new nconf.Provider().argv().env().file({file: __dirname + '/resources/config.json'}),
    cache_classifications = new nconf.Provider().file({file: __dirname + '/resources/markify_classifications.json'}),
    cache_requests = new nconf.Provider().file({file: __dirname + '/resources/cache_requests.json'}),
    tokenizer = new natural.RegexpTokenizer({pattern: /[!@#$%^&*()_+=\[{\]};:<>\|\.\/\?,\\"-\s]/}),
    logger = new (winston.Logger)({ transports: [ new (winston.transports.Console)({ level: 'info', timestamp: true }) ] }),
    searchowner_url_base = 'http://www.markify.com/api/searchowner.json?',
    search_url_base = 'http://www.markify.com/api/search.json?database=USPTO&',
    trademarks_url_base = 'http://trademark.markify.com/trademarks/',
    jurisdiction_path = { 'US': 'USPTO', 'WIPO': 'WIPO', 'Europe': 'ctm' },
    page_limit = 100,
    search_limit = 1000,
    start_index = 0,
    markify_auth = { 'auth': { 'user': config.get('MARKIFY_USERNAME'), 'pass': config.get('MARKIFY_PASSWORD'), 'sendImmediately': false }},
    business_types = config.get('BUSINESS_TYPES'),
    common_words = config.get('COMMON_WORDS'),
    join_separator = ' ';

//sort the business types by length, so the longest-possible substring would be cutout
business_types.sort(function(a, b){
    'use strict';
    return b.length - a.length;
});
business_types.forEach(function(business_type, index, array){
    'use strict';
    array[index] = new RegExp('\\b' + tokenizer.tokenize(business_type).join(join_separator) + '\\b$', 'i');
});

var markifyClassification = function(search_result, cb){
    'use strict';
    assert(search_result.mark && search_result.mark.length);
    var trademarks_url = trademarks_url_base + jurisdiction_path[search_result.market] + '/' + querystring.escape(search_result.mark) + '/' + search_result.id;
    //logger.info('trademarks_url: ' + trademarks_url);
    var search_result_classes = cache_requests.get(encodeURI(trademarks_url));
    if(search_result_classes){
        cb(null, search_result_classes);
        return;
    }

    request.get(trademarks_url, function(error, response, body){
        if(!error && response.statusCode === 200){
            body = body.replace(/&\w+;/gm, '');
            var doc = new dom({
                locator:{},
                errorHandler:{
                    warning: function(w){
                        logger.warn(w);
                    },
                    error: function(e){
                        logger.error(e);
                    },
                    fatalError:function(e){
                        logger.error(e);
                    }
                }
            }).parseFromString(body);

            var search_result_classes = xpath.select('//p[@class="serp2info2"]/text()', doc).join(join_separator);
            cache_requests.set(encodeURIComponent(trademarks_url), search_result_classes);
            //logger.info('search_result_classes: ' + search_result_classes);
            cb(null, search_result_classes);
            cache_requests.save();
            return;
        }
        logger.error('markifyClassification response:' + JSON.stringify(response, null, 4));
        cb(error || response.statusCode);
    });
};

var markifySearch = function(querystring_search, callback){
    'use strict';

    var search_url = search_url_base + querystring_search;
    console.log('BEFORE cache_requests: ' + search_url);
    var search_result = cache_requests.get(encodeURIComponent(search_url));
    console.log('AFTER cache_requests');
    if(search_result){
        callback(null, search_result.result, search_result.totalFound);
        return;
    }
    console.log('search_result: ' + JSON.stringify(search_result, null, 4));

    var operation = retry.operation({
        retries: 3,
        factor: 3,
        minTimeout: 1 * 1000,
        maxTimeout: 5 * 1000,
        randomize: true
    });

    operation.attempt(function(currentAttempt){
        request.get(search_url, markify_auth, function(error, response, body){

            if(operation.retry()){
                callback(operation.mainError());
                return;
            }

            if(operation.retry(error)){
                return;
            }

            if(!operation.mainError() && response.statusCode === 200){
                try {
                    search_result = JSON.parse(body);
                    if(!search_result.result){
                        callback(null, [], 0);
                        return;
                    }
                    cache_requests.set(encodeURIComponent(search_url), { result: search_result.result, totalFound: search_result.meta.totalFound });
                    callback(null, search_result.result, search_result.meta.totalFound);
                    cache_requests.save();
                    return;
                }
                catch(e){
                    console.log('body: '+body);
                    console.log('search_url: '+search_url);
                    console.log('response: '+JSON.stringify(response, null, 4));
                    console.log('e: '+e);
                    operation.retry(e);
                    return;
                }
            }
            callback(operation.mainError() || response.statusCode);
        });
    });

};

var classFilter = function(tokenized_class){
    'use strict';
    return tokenized_class.length > 2 &&
        common_words.indexOf(tokenized_class) === -1 &&
        !/^[0-9]+$/.test(tokenized_class);
};

//grab all results associated with a trademark
//trim the 'owners' strings by business_types and removal of extra characters
//select the 'owners' with most registred TMs
//foreach TM belonging to the selected 'owners'
    //load the TM's page and scrape the //p[@class="serp2info2"]
//now I have a list of all the class strings, clean it up
//clean up: remove common words, create singular & plurals, see what stemming gives

var normalizeLabel = function(label){
    'use strict';
    return tokenizer.tokenize(label.toLowerCase()).join(join_separator);
}

var markifyGetClassifications = function(trademark, callback){
    'use strict';
    var search_query = {'mark': trademark, 'startIndex': start_index, 'pageLimit': page_limit };
    var normalized_trademark = normalizeLabel(trademark);
    var trademark_regex = new RegExp('\\b' + normalized_trademark.replace(join_separator, '.*') + '\\b', 'i');

    markifySearch(querystring.stringify(search_query), function(error, search_result_page1, total_found){
        if(error){
            logger.error('markify_search_1: ' + error);
            callback(error);
            return;
        }

        var search_queries = [];
        while(total_found > start_index + page_limit && Math.max(search_limit, total_found/2) > start_index + page_limit){
            start_index += page_limit;
            search_query = {'mark': normalized_trademark, 'startIndex': start_index, 'pageLimit': page_limit };
            search_queries.push(querystring.stringify(search_query));
        }

        async.waterfall([
            //markifySearch any remaining pages (beyond the first page_limit)
            function(cbWaterfall){
                async.map(search_queries, markifySearch, function(err, search_results, total_found){
                    if(err){
                        cbWaterfall('markify_search_n: ' + err);
                        return;
                    }
                    //merge the results array (flatten it out)
                    search_results.unshift(search_result_page1);
                    search_results = search_results.reduce(function(a, b){
                        return a.concat(b);
                    }).filter(function(result){ return result.mark.length;});

                    logger.info('search_results: ' + JSON.stringify(search_results, null, 4));
                    cbWaterfall(null, search_results);
                });
            },
            //identify the most probable trademark owner
            function(search_results, cbWaterfall){

                var owner_trademark_counts = [];  //{owner_trademark: 'xyz', count: 8}
                search_results.forEach(function(search_result, search_result_index, search_result_array){
                    var normalized_owner = normalizeLabel(search_result.owners);
                    var search_result_matched = business_types.filter(function(business_type){
                        business_type.test(normalized_owner);
                    });

                    if(search_result_matched.length){
                        normalized_owner = normalized_owner.replace(search_result_matched[0], '').trim();
                    }

                    search_result_array[search_result_index].owners = normalized_owner;

                    var index = owner_trademark_counts.map(function(d){ return d.owner_trademark; }).indexOf(normalized_owner);
                    if(index === -1){
                        owner_trademark_counts.push({'owner_trademark': normalized_owner, 'count': 1});
                    }
                    else {
                        owner_trademark_counts[index].count += 1;
                    }
                });
                owner_trademark_counts.sort(function(a, b){
                    return b.count - a.count;
                });

                var owner_exact_trademark_counts = [];  //{owner_trademark: 'xyz', count: 8}
                var owner_exact_trademark_search_results = search_results.filter(function(search_result){
                    return search_result.mark.toLowerCase() === trademark.toLowerCase() ||
                        search_result.mark.toLowerCase() === trademark.toLowerCase().replace(/\W/gi, '') + '.com';
                });
                owner_exact_trademark_search_results.forEach(function(search_result, search_result_index, search_result_array){
                    var normalized_owner = normalizeLabel(search_result.owners);
                    var index = owner_exact_trademark_counts.map(function(d){ return d.owner_trademark; }).indexOf(normalized_owner);
                    if(index === -1){
                        owner_exact_trademark_counts.push({'owner_trademark': search_result.owners, 'count': 1});
                    }
                    else {
                        owner_exact_trademark_counts[index].count += 1;
                    }
                });
                owner_exact_trademark_counts.sort(function(a, b){
                    return b.count - a.count;
                });

                var probable_trademark_owners = owner_trademark_counts.filter(function(owner_trademark_count){
                    return trademark_regex.test(owner_trademark_count.owner_trademark);
                });
                probable_trademark_owners.sort(function(a, b){
                    return b.count - a.count;
                });


                var probable_trademark_owner = 'Not Found!';
                if(owner_exact_trademark_counts.length){
                    probable_trademark_owner = owner_exact_trademark_counts[0].owner_trademark;
                }
                else if(probable_trademark_owners.length){
                    probable_trademark_owner = probable_trademark_owners[0].owner_trademark;
                }
                else if(owner_trademark_counts.length && owner_trademark_counts[0].count > 1){
                    probable_trademark_owner = owner_trademark_counts[0].owner_trademark;
                }

                logger.info('owner_exact_trademark_counts: ' + JSON.stringify(owner_exact_trademark_counts, null, 4));
                logger.info('owner_trademark_counts: ' + JSON.stringify(owner_trademark_counts, null, 4));
                logger.info('probable_trademark_owners: ' + JSON.stringify(probable_trademark_owners, null, 4));
                logger.info('trademark_regex: ' + trademark_regex);
                logger.info('probable_trademark_owners: ' + JSON.stringify(probable_trademark_owners, null, 4));
                logger.info('probable_trademark_owner: ' + probable_trademark_owner);
                cbWaterfall(null, search_results, probable_trademark_owner);
            },
            //get complete list of classes that the trademark owner has filed under (QUALIFIER WORDS TO INCLUDE)
            function(search_results, trademark_owner, cbWaterfall){

                var search_results_trademark_owner = search_results.filter(function(search_result){
                    return search_result.owners === trademark_owner;
                });

                //double count the trademarks that are an exact match for what we are looking for
                search_results_trademark_owner = search_results_trademark_owner.concat(search_results_trademark_owner.filter(function(search_result){
                    return trademark_regex.test(search_result.mark);
                }));

                async.reduce(search_results_trademark_owner, 0, function(search_result_classes_1, search_result_classes_2, cb){
                    assert(search_result_classes_2.mark);
                    markifyClassification(search_result_classes_2, function(err, trademark_owner_classes){
                        if(err){
                            cb(err);
                            return;
                        }
                        cb(null, search_result_classes_1 ? search_result_classes_1 + join_separator + trademark_owner_classes : trademark_owner_classes );
                        return;
                    });
                },
                function(err, trademark_owner_classes){
                    if(err){
                        cbWaterfall(err);
                        return;
                    }
                    cbWaterfall(null, search_results, trademark_owner, trademark_owner_classes || '');
                });
            },
            //get complete list of classes that OTHER trademark owners have filed (DISQUALIFIER WORDS TO EXLUDE)
            function(search_results, trademark_owner, trademark_owner_classes, cbWaterfall){

                var search_results_other_trademark_owners = search_results.filter(function(search_result){
                    return search_result.owners !== trademark_owner;
                });

                async.reduce(search_results_other_trademark_owners, 0, function(search_result_classes_1, search_result_classes_2, cb){
                    assert(search_result_classes_2.mark);
                    markifyClassification(search_result_classes_2, function(err, other_trademark_classes){
                        if(err){
                            cb(err);
                            return;
                        }
                        cb(null, search_result_classes_1 ? search_result_classes_1 + join_separator + other_trademark_classes : other_trademark_classes );
                        return;
                    });
                },
                function(err, other_trademark_classes){
                    if(err){
                        cbWaterfall(err);
                        return;
                    }
                    cbWaterfall(null, trademark_owner, trademark_owner_classes, other_trademark_classes || '');
                });
            },
            //normalize the trademark classes to get list of words
            function(trademark_owner, trademark_owner_classes, other_trademark_classes, cbWaterfall){

                trademark_owner_classes = trademark_owner_classes.toLowerCase();
                var trademark_owner_tokens_normalized = tokenizer.tokenize(trademark_owner_classes).filter(classFilter);

                other_trademark_classes = other_trademark_classes.toLowerCase();
                var other_trademark_tokens_normalized = tokenizer.tokenize(other_trademark_classes).filter(classFilter).filter(function(token){
                    return trademark_owner_tokens_normalized.indexOf(token) === -1;
                });

                logger.info('trademark_owner_tokens_normalized: ' + JSON.stringify(trademark_owner_tokens_normalized, null, 4));
                var trademark_owner_class_counts = [];  //{trademark_class: 'xyz', count: 8}
                trademark_owner_tokens_normalized.forEach(function(normalized_class){
                    //TODO, I shouldn't have nulls here to begin with! this IF is just to get it going for now
                    if(!normalized_class){
                        return;
                    }
                    assert(normalized_class);

                    var index = trademark_owner_class_counts.map(function(d){ return d.trademark_class; }).indexOf(normalized_class);
                    if(index === -1){
                        //logger.info('trademark_owner_class_counts.push: ' + JSON.stringify({'trademark_class': normalized_class, 'count': 1}));
                        trademark_owner_class_counts.push({'trademark_class': normalized_class, 'count': 1});
                    }
                    else {
                        //logger.info('trademark_owner_class_counts.count++: ' + JSON.stringify({'trademark_class': trademark_owner_class_counts[index].trademark_class, 'count': trademark_owner_class_counts[index].count+1}));
                        trademark_owner_class_counts[index].count += 1;
                    }
                });
                //order the words based on their frequency
                trademark_owner_class_counts.sort(function(a, b){
                    return b.count - a.count;
                });
                logger.info('trademark_owner_class_counts: ' + JSON.stringify(trademark_owner_class_counts, null, 4));

                var other_trademark_class_counts = [];  //{trademark_class: 'xyz', count: 8}
                other_trademark_tokens_normalized.forEach(function(normalized_class){
                    if(!normalized_class){
                        return;
                    }
                    var index = other_trademark_class_counts.map(function(d){ return d.trademark_class; }).indexOf(normalized_class);
                    if(index === -1){
                        other_trademark_class_counts.push({'trademark_class': normalized_class, 'count': 1});
                    }
                    else {
                        other_trademark_class_counts[index].count += 1;
                    }
                });
                //order the words based on their frequency
                other_trademark_class_counts.sort(function(a, b){
                    return b.count - a.count;
                });

                var include_classes = trademark_owner_class_counts.reduce(function(a, b){
                    if(b.count > 1 || trademark_regex.test(b.trademark_class) || trademark_regex.test(trademark_owner)){
                        return a + join_separator + b.trademark_class;
                    }
                    assert(typeof(a) === 'string');
                    return a;
                }, '');

                var exclude_classes = other_trademark_class_counts.reduce(function(a, b){
                    //if any of the classes are both in include & exclude lists, then drop them from exclusion list
                    var index = trademark_owner_class_counts.map(function(d){ return d.trademark_class; }).indexOf(b.trademark_class);
                    if(b.count > 5 && index === -1){
                        return a + join_separator + b.trademark_class;
                    }
                    assert(typeof(a) === 'string');
                    return a;
                }, '');

                logger.info('trademark_owner_class_counts: ' + JSON.stringify(trademark_owner_class_counts, null, 4));
                logger.info('other_trademark_class_counts: ' + JSON.stringify(other_trademark_class_counts, null, 4));
                logger.info('trademark_owner: ' + trademark_owner);
                logger.info('include_classes: ' + JSON.stringify(include_classes, null, 4));
                logger.info('exclude_classes: ' + JSON.stringify(exclude_classes, null, 4));
                cbWaterfall(null, trademark_owner, trademark_owner_class_counts, include_classes, exclude_classes);
            }
        ],
        function(err, trademark_owner, trademark_owner_class_counts, include_classes, exclude_classes){
            if(err){
                callback(err);
                return;
            }
            callback(null, trademark_owner, include_classes, exclude_classes);
        });
    });
};


//node markify.js --BRAND="AT&T" > ATT.markify;node markify.js --BRAND="U.S. Cellular" > USCellular.markify;node markify.js --BRAND="Disney" > Disney.markify;node markify.js --BRAND="Walmart" > Walmart.markify;node markify.js --BRAND="AOL" > AOL.markify;node markify.js --BRAND="Apple" > Apple.markify;node markify.js --BRAND="HP" > HP.markify;node markify.js --BRAND="Canon" > Canon.markify;node markify.js --BRAND="Nikon" > Nikon.markify;node markify.js --BRAND="Verizon" > Verizon.markify;node markify.js --BRAND="BestBuy" > BestBuy.markify;node markify.js --BRAND="Samsung" > Samsung.markify;node markify.js --BRAND="Gigya" > Gigya.markify;node markify.js --BRAND="Electrolux" > Electrolux.markify;node markify.js --BRAND="Klipsch" > Klipsch.markify;node markify.js --BRAND="Plantronics" > Plantronics.markify;node markify.js --BRAND="L’Oréal" > LOreal.markify;node markify.js --BRAND="Mini" > Mini.markify;node markify.js --BRAND="COACH" > COACH.markify;node markify.js --BRAND="Bose" > Bose.markify;node markify.js --BRAND="Jouer" > Jouer.markify;node markify.js --BRAND="Bionaire" > Bionaire.markify;node markify.js --BRAND="Duxiana" > Duxiana.markify;node markify.js --BRAND="The North Face" > TheNorthFace.markify;node markify.js --BRAND="Brita Water Filters" > BritaWaterFilters.markify;node markify.js --BRAND="BoConcept Furniture" > BoConceptFurniture.markify;node markify.js --BRAND="One Medical Group" > OneMedicalGroup.markify;node markify.js --BRAND="Sonicare" > Sonicare.markify;node markify.js --BRAND="Don Julio" > DonJulio.markify;node markify.js --BRAND="Lincoln" > Lincoln.markify;node markify.js --BRAND="Porsche" > Porsche.markify;node markify.js --BRAND="Nest" > Nest.markify;node markify.js --BRAND="Quantum" > Quantum.markify;node markify.js --BRAND="Constant Contact" > ConstantContact.markify;node markify.js --BRAND="Cadillac" > Cadillac.markify;node markify.js --BRAND="Allstate" > Allstate.markify;node markify.js --BRAND="Loudmouth Golf" > LoudmouthGolf.markify;node markify.js --BRAND="Wolf of Wall Street" > WolfofWallStreet.markify;node markify.js --BRAND="Southern New Hampshire University" > SouthernNewHampshireUniversity.markify;node markify.js --BRAND="FreshBooks" > FreshBooks.markify;node markify.js --BRAND="inPowered" > inPowered.markify;

var getClassifications = function(brand_name, force_refresh, callback){
    'use strict';
    if(typeof(force_refresh) === 'function'){
        callback = force_refresh;
    }


    var normalized_brand_name = normalizeLabel(brand_name);
    var cached_classification = cache_classifications.get(normalized_brand_name);
    if(cached_classification){
        callback(null, cached_classification.trademark_owner, cached_classification.include_classes, cached_classification.exclude_classes);
        return;
    }
    else {
        markifyGetClassifications(brand_name, function(err, trademark_owner, include_classes, exclude_classes){
            if(err){
                logger.error('getClassifications: ' + err);
                callback(err);
                return;
            }
            cache_classifications.set(normalized_brand_name, {
                'brand_name': brand_name,
                'normalized_brand_name': normalized_brand_name,
                'trademark_owner': trademark_owner,
                'include_classes': include_classes,
                'exclude_classes': exclude_classes,
            });
            cache_classifications.save();
            callback(null, trademark_owner, include_classes, exclude_classes);
        });
    }
};

//export the function
exports.getClassifications = getClassifications;
exports.normalizeLabel = normalizeLabel;
