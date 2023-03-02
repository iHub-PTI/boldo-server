//Broad util methods

//creates a joined query params for sending to JAX-RS in core-health-mapper
export const genericQueryParamsMaker = (params: Object) => {
    let joinedParams = ''
    if (params){
        for (const [key, value] of Object.entries(params)){
            if (Array.isArray(value)){
                value.forEach( (val: any) =>{
                    if (val) {
                        joinedParams = joinedParams + `${key}=${val}&`
                    }
                });
            }else{
                joinedParams = joinedParams + `${key}=${value}&`
            }
        }
    }
    return joinedParams;
}